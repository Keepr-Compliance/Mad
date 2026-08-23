/**
 * EmailThreadCard Tests
 * TASK-1183: Tests for email thread grouping and display
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  EmailThreadCard,
  normalizeSubject,
  groupEmailsByThread,
  createEmailThreads,
  sortEmailThreadsByRecent,
  processEmailThreads,
} from "../EmailThreadCard";
import type { EmailThread } from "../EmailThreadCard";
import type { Communication } from "../../types";

// Helper to create mock emails
function createMockEmail(overrides: Partial<Communication> = {}): Communication {
  return {
    id: `email-${Math.random().toString(36).substr(2, 9)}`,
    user_id: "user-1",
    communication_type: "email",
    channel: "email",
    sender: "sender@example.com",
    recipients: "recipient@example.com",
    subject: "Test Subject",
    body_plain: "Test body",
    sent_at: new Date().toISOString(),
    has_attachments: false,
    is_false_positive: false,
    created_at: new Date().toISOString(),
    ...overrides,
  } as Communication;
}

describe("normalizeSubject", () => {
  it("removes Re: prefix", () => {
    expect(normalizeSubject("Re: Hello")).toBe("hello");
    expect(normalizeSubject("RE: Hello")).toBe("hello");
    expect(normalizeSubject("re: Hello")).toBe("hello");
  });

  it("removes Fwd: and FW: prefixes", () => {
    expect(normalizeSubject("Fwd: Hello")).toBe("hello");
    expect(normalizeSubject("FW: Hello")).toBe("hello");
    expect(normalizeSubject("Fw: Hello")).toBe("hello");
    expect(normalizeSubject("fwd: Hello")).toBe("hello");
  });

  it("removes multiple prefixes", () => {
    expect(normalizeSubject("Re: Re: Hello")).toBe("hello");
    expect(normalizeSubject("Fwd: Re: Hello")).toBe("hello");
    expect(normalizeSubject("Re: Fwd: Re: Hello")).toBe("hello");
  });

  it("handles empty/null subjects", () => {
    expect(normalizeSubject("")).toBe("");
    expect(normalizeSubject(null)).toBe("");
    expect(normalizeSubject(undefined)).toBe("");
  });

  it("preserves original subject when no prefix", () => {
    expect(normalizeSubject("Hello World")).toBe("hello world");
  });
});

describe("groupEmailsByThread", () => {
  it("groups emails by thread_id", () => {
    const emails = [
      createMockEmail({ id: "1", thread_id: "thread-A", subject: "Hello" }),
      createMockEmail({ id: "2", thread_id: "thread-A", subject: "Re: Hello" }),
      createMockEmail({ id: "3", thread_id: "thread-B", subject: "Other" }),
    ];

    const grouped = groupEmailsByThread(emails);

    expect(grouped.size).toBe(2);
    expect(grouped.get("thread-thread-A")).toHaveLength(2);
    expect(grouped.get("thread-thread-B")).toHaveLength(1);
  });

  it("falls back to subject grouping when thread_id is missing", () => {
    const emails = [
      createMockEmail({ id: "1", subject: "Hello" }),
      createMockEmail({ id: "2", subject: "Re: Hello" }),
    ];

    const grouped = groupEmailsByThread(emails);

    expect(grouped.size).toBe(1);
    expect(grouped.get("subject-hello")).toHaveLength(2);
  });

  it("groups emails by normalized subject when no thread ID", () => {
    const emails = [
      createMockEmail({ id: "1", subject: "Project Update" }),
      createMockEmail({ id: "2", subject: "Re: Project Update" }),
      createMockEmail({ id: "3", subject: "RE: project update" }),
    ];

    const grouped = groupEmailsByThread(emails);

    // All three should be in the same group (normalized subject)
    expect(grouped.size).toBe(1);
    const threadKey = Array.from(grouped.keys())[0];
    expect(grouped.get(threadKey)).toHaveLength(3);
  });

  it("creates separate threads for different subjects", () => {
    const emails = [
      createMockEmail({ id: "1", subject: "Topic A" }),
      createMockEmail({ id: "2", subject: "Topic B" }),
    ];

    const grouped = groupEmailsByThread(emails);

    expect(grouped.size).toBe(2);
  });

  it("sorts emails within thread chronologically", () => {
    const emails = [
      createMockEmail({ id: "3", thread_id: "t1", sent_at: "2024-01-03T10:00:00Z" }),
      createMockEmail({ id: "1", thread_id: "t1", sent_at: "2024-01-01T10:00:00Z" }),
      createMockEmail({ id: "2", thread_id: "t1", sent_at: "2024-01-02T10:00:00Z" }),
    ];

    const grouped = groupEmailsByThread(emails);
    const thread = grouped.get("thread-t1");

    expect(thread).toBeDefined();
    expect(thread![0].id).toBe("1");
    expect(thread![1].id).toBe("2");
    expect(thread![2].id).toBe("3");
  });

  it("filters out non-email communications", () => {
    const communications = [
      createMockEmail({ id: "1", subject: "Email" }),
      createMockEmail({ id: "2", communication_type: "text", channel: "sms", subject: "Text" }),
      createMockEmail({ id: "3", subject: "Another Email" }),
    ];

    const grouped = groupEmailsByThread(communications);

    // Should only have 2 emails (text message filtered out)
    let totalEmails = 0;
    grouped.forEach((emails) => {
      totalEmails += emails.length;
    });
    expect(totalEmails).toBe(2);
  });
});

describe("createEmailThreads", () => {
  it("creates EmailThread objects from grouped emails", () => {
    const emails = [
      createMockEmail({
        id: "1",
        thread_id: "t1",
        subject: "Meeting",
        sender: "Alice <alice@example.com>",
        recipients: "bob@example.com",
        sent_at: "2024-01-01T10:00:00Z",
      }),
      createMockEmail({
        id: "2",
        thread_id: "t1",
        subject: "Re: Meeting",
        sender: "Bob <bob@example.com>",
        recipients: "alice@example.com",
        sent_at: "2024-01-02T10:00:00Z",
      }),
    ];

    const grouped = groupEmailsByThread(emails);
    const threads = createEmailThreads(grouped);

    expect(threads).toHaveLength(1);
    const thread = threads[0];
    expect(thread.subject).toBe("Meeting");
    expect(thread.emailCount).toBe(2);
    expect(thread.participants).toContain("Alice <alice@example.com>");
    expect(thread.startDate.toISOString()).toBe("2024-01-01T10:00:00.000Z");
    expect(thread.endDate.toISOString()).toBe("2024-01-02T10:00:00.000Z");
  });

  it("deduplicates participants by email address", () => {
    const emails = [
      createMockEmail({
        id: "1",
        thread_id: "t1",
        sender: "alice@example.com",
        recipients: "bob@example.com",
      }),
      createMockEmail({
        id: "2",
        thread_id: "t1",
        sender: "Alice Smith <alice@example.com>",
        recipients: "bob@example.com",
      }),
    ];

    const grouped = groupEmailsByThread(emails);
    const threads = createEmailThreads(grouped);

    // Should prefer the version with display name
    const thread = threads[0];
    const aliceEntries = thread.participants.filter((p) =>
      p.toLowerCase().includes("alice")
    );
    expect(aliceEntries).toHaveLength(1);
    expect(aliceEntries[0]).toContain("Alice Smith");
  });
});

describe("sortEmailThreadsByRecent", () => {
  it("sorts threads by most recent email (newest first)", () => {
    const threads = [
      {
        id: "old",
        subject: "Old Thread",
        participants: [],
        emailCount: 1,
        startDate: new Date("2024-01-01"),
        endDate: new Date("2024-01-01"),
        emails: [],
      },
      {
        id: "new",
        subject: "New Thread",
        participants: [],
        emailCount: 1,
        startDate: new Date("2024-01-05"),
        endDate: new Date("2024-01-10"),
        emails: [],
      },
      {
        id: "middle",
        subject: "Middle Thread",
        participants: [],
        emailCount: 1,
        startDate: new Date("2024-01-03"),
        endDate: new Date("2024-01-05"),
        emails: [],
      },
    ];

    const sorted = sortEmailThreadsByRecent(threads);

    expect(sorted[0].id).toBe("new");
    expect(sorted[1].id).toBe("middle");
    expect(sorted[2].id).toBe("old");
  });
});

describe("processEmailThreads", () => {
  it("processes communications into sorted email threads", () => {
    const communications = [
      createMockEmail({
        id: "1",
        thread_id: "t1",
        subject: "First Thread",
        sent_at: "2024-01-01T10:00:00Z",
      }),
      createMockEmail({
        id: "2",
        thread_id: "t1",
        subject: "Re: First Thread",
        sent_at: "2024-01-02T10:00:00Z",
      }),
      createMockEmail({
        id: "3",
        thread_id: "t2",
        subject: "Second Thread",
        sent_at: "2024-01-05T10:00:00Z",
      }),
    ];

    const threads = processEmailThreads(communications);

    // Should have 2 threads, sorted by most recent
    expect(threads).toHaveLength(2);
    expect(threads[0].subject).toBe("Second Thread"); // More recent
    expect(threads[1].subject).toBe("First Thread");
  });

  it("handles empty communications array", () => {
    const threads = processEmailThreads([]);
    expect(threads).toHaveLength(0);
  });

  it("handles single email", () => {
    const communications = [
      createMockEmail({ id: "1", subject: "Solo Email" }),
    ];

    const threads = processEmailThreads(communications);

    expect(threads).toHaveLength(1);
    expect(threads[0].emailCount).toBe(1);
  });
});


/**
 * BACKLOG-2826 — founder, 2026-08-23: "a lone email should open in conversation
 * view."
 *
 * The card used to branch on thread length: N emails opened
 * EmailThreadViewModal (the conversation), a lone email called `onViewEmail`,
 * which mounts the plain reader (EmailViewModal) at the TransactionDetails
 * level. Two different viewers for the same affordance. Now every thread opens
 * the conversation, and the reader is one click deeper — "Open Full Email →"
 * inside the expanded bubble — so EmailViewModal is not stranded.
 */
describe("View target — every thread opens the conversation view (BACKLOG-2826)", () => {
  function makeThread(emails: Communication[]): EmailThread {
    return {
      id: "thread-view-target",
      subject: "Inspection addendum",
      participants: ["paul@example.com"],
      emailCount: emails.length,
      startDate: new Date(emails[0].sent_at as string),
      endDate: new Date(emails[emails.length - 1].sent_at as string),
      emails,
    };
  }

  const lone = makeThread([
    createMockEmail({
      id: "e-1",
      sender: "Paul Rivera <paul@example.com>",
      recipients: "me@example.com",
      subject: "Inspection addendum",
      body_text: "Attaching the signed addendum.",
      sent_at: "2024-01-01T10:00:00Z",
    } as Partial<Communication>),
  ]);

  const conversation = makeThread([
    createMockEmail({ id: "e-1", subject: "Inspection addendum", body_text: "First", sent_at: "2024-01-01T10:00:00Z" } as Partial<Communication>),
    createMockEmail({ id: "e-2", subject: "Re: Inspection addendum", body_text: "Second", sent_at: "2024-01-02T10:00:00Z" } as Partial<Communication>),
  ]);

  it("a ONE-email thread opens the conversation modal, not the plain reader", () => {
    const onViewEmail = jest.fn();
    render(<EmailThreadCard thread={lone} onViewEmail={onViewEmail} />);

    expect(screen.queryByTestId("email-thread-view-modal")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("view-thread-button"));

    expect(screen.getByTestId("email-thread-view-modal")).toBeInTheDocument();
    // The old branch called this instead of opening the conversation.
    expect(onViewEmail).not.toHaveBeenCalled();
  });

  it("an N-email thread still opens the conversation modal — unchanged", () => {
    const onViewEmail = jest.fn();
    render(<EmailThreadCard thread={conversation} onViewEmail={onViewEmail} />);

    fireEvent.click(screen.getByTestId("view-thread-button"));

    expect(screen.getByTestId("email-thread-view-modal")).toBeInTheDocument();
    expect(onViewEmail).not.toHaveBeenCalled();
  });

  it("the plain reader stays reachable: 'Open Full Email →' inside the conversation calls onViewEmail", () => {
    const onViewEmail = jest.fn();
    render(<EmailThreadCard thread={lone} onViewEmail={onViewEmail} />);

    fireEvent.click(screen.getByTestId("view-thread-button"));
    // A lone email starts expanded, so the escape hatch needs no extra tap.
    fireEvent.click(screen.getByText("Open Full Email →"));

    expect(onViewEmail).toHaveBeenCalledWith(lone.emails[0]);
  });

  it("still shows the '(N emails)' count for a real conversation, and none for one email", () => {
    const { unmount } = render(<EmailThreadCard thread={conversation} />);
    expect(screen.getByText("(2 emails)")).toBeInTheDocument();
    unmount();

    render(<EmailThreadCard thread={lone} />);
    expect(screen.queryByText(/emails\)/)).not.toBeInTheDocument();
  });
});
