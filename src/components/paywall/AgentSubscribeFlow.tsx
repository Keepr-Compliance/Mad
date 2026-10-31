/**
 * AgentSubscribeFlow — BACKLOG-3676, the screens after "Subscribe" (tab A2
 * steps 2 and 3): Waiting → Success / Pending / Failed.
 *
 * Main has already opened Stripe's hosted Checkout in the browser. This screen
 * waits for the browser to come back:
 *   - deep link WITH a session id (payment completed page) → confirmSubscription
 *     (main polls fresh gate reads, up to 15 x 2 s);
 *   - deep link with NO session id (the cancelled page) → one fresh gate read,
 *     then back to the cards with "Checkout cancelled. Nothing was charged.";
 *   - window focus (the user came back without the deep link) → one fresh gate
 *     read; still locked → keep waiting.
 * Success only when main's gate read says unlocked (fail-closed). A ref guard
 * keeps a second trigger from starting a second confirm while one runs (S2;
 * main joins duplicates too).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@keepr/ui";
import { paymentService } from "../../services/paymentService";
import { billingService } from "../../services/billingService";

type Step = "waiting" | "success" | "pending" | "failed";

export interface AgentSubscribeFlowProps {
  transactionId: string;
  /** e.g. "$19.99" from the portal; null if the price was not read. */
  priceDisplay: string | null;
  creditCount: number;
  /** Plan is on and this deal is unlocked: caller re-runs the export. */
  onContinue: () => void;
  /** Back to the cards, with an optional notice ("cancelled"). */
  onBack: (notice?: "cancelled") => void;
  /** Close the paywall and keep working ("Keep working"). */
  onKeepWorking: () => void;
  /** Open Checkout again ("Reopen checkout" / "Try again" after a failure). */
  onReopen: () => Promise<boolean>;
}

export function AgentSubscribeFlow({
  transactionId,
  priceDisplay,
  creditCount,
  onContinue,
  onBack,
  onKeepWorking,
  onReopen,
}: AgentSubscribeFlowProps): React.ReactElement {
  const [step, setStepState] = useState<Step>("waiting");
  const [reopened, setReopened] = useState(false);
  const [checking, setChecking] = useState(false);
  const stepRef = useRef<Step>("waiting");
  /** The confirm or read running now (S2 renderer guard). */
  const runningRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);

  const setStep = useCallback((next: Step) => {
    stepRef.current = next;
    setStepState(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Deep-link work QUEUES behind whatever runs now and is skipped once the
   * screen has left Waiting, so a second deep link never starts a second poll.
   */
  const enqueue = useCallback((work: () => Promise<void>): Promise<void> => {
    const prior = runningRef.current ?? Promise.resolve();
    const next = prior
      .then(async () => {
        if (!mountedRef.current || stepRef.current !== "waiting") return;
        await work();
      })
      .finally(() => {
        if (runningRef.current === next) runningRef.current = null;
      });
    runningRef.current = next;
    return next;
  }, []);

  /** A focus or "Check again" read is skipped while anything else runs. */
  const runIfIdle = useCallback(
    (work: () => Promise<void>): Promise<void> => {
      if (runningRef.current) return runningRef.current;
      return enqueue(work);
    },
    [enqueue],
  );

  const confirmAfterCheckout = useCallback(
    () =>
      enqueue(async () => {
        const result = await paymentService.confirmSubscription(transactionId);
        if (!mountedRef.current) return;
        if (result.unlocked) {
          setStep("success");
          return;
        }
        const summary = await billingService.getPlanSummary();
        if (!mountedRef.current) return;
        const failed = !summary.unavailable && summary.summary.state === "payment_failed";
        setStep(failed ? "failed" : "pending");
      }),
    [enqueue, setStep, transactionId],
  );

  const freshRead = useCallback(
    async (whenLocked: () => void): Promise<void> => {
      const gate = await paymentService.refreshGate(transactionId);
      if (!mountedRef.current) return;
      if (gate.unlocked) setStep("success");
      else whenLocked();
    },
    [setStep, transactionId],
  );

  // Browser return: the payment-callback deep link.
  useEffect(() => {
    if (step !== "waiting") return undefined;
    return paymentService.onDeepLinkCallback(({ sessionId }) => {
      if (sessionId) {
        void confirmAfterCheckout();
      } else {
        void enqueue(() => freshRead(() => onBack("cancelled")));
      }
    });
  }, [step, confirmAfterCheckout, enqueue, freshRead, onBack]);

  // The user came back to the app without the deep link: one fresh read.
  useEffect(() => {
    if (step !== "waiting" || typeof window === "undefined") return undefined;
    const onFocus = (): void => {
      void runIfIdle(() => freshRead(() => undefined));
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [step, runIfIdle, freshRead]);

  const handleReopen = async (): Promise<void> => {
    setReopened(false);
    const opened = await onReopen();
    if (!mountedRef.current) return;
    if (opened) {
      setStep("waiting");
      setReopened(true);
    }
  };

  const handleCheckAgain = async (): Promise<void> => {
    setChecking(true);
    try {
      // From Pending: a plain fresh read (the queue only runs while Waiting).
      await freshRead(() => undefined);
    } finally {
      if (mountedRef.current) setChecking(false);
    }
  };

  const item = priceDisplay ? `Agent plan, ${priceDisplay} / month` : "Agent plan";

  if (step === "success") {
    return (
      <div
        className="mx-auto max-w-xl rounded-lg border border-primary/30 bg-primary/5 p-5 text-center"
        data-testid="agent-flow-success"
      >
        <p className="text-sm font-semibold text-gray-900">You&apos;re on the Agent plan</p>
        <p className="mt-1 text-sm text-gray-700">Unlimited exports are on.</p>
        {creditCount > 0 && (
          <p className="mx-auto mt-2 max-w-sm text-xs text-gray-600">
            Your {creditCount} credit{creditCount === 1 ? "" : "s"} stay on your account. They are
            not used while you are subscribed.
          </p>
        )}
        <Button className="mt-4" size="lg" onClick={onContinue} data-testid="agent-flow-continue">
          Continue export
        </Button>
      </div>
    );
  }

  if (step === "pending") {
    return (
      <div
        className="mx-auto max-w-xl rounded-lg border border-gray-200 bg-gray-50 p-5 text-center"
        data-testid="agent-flow-pending"
      >
        <p className="text-sm font-semibold text-gray-900">We&apos;re confirming your payment</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-gray-700">This can take a minute.</p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-gray-500">
          You can keep working. Unlimited exports turn on as soon as the payment is confirmed.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          <Button size="lg" onClick={onKeepWorking} data-testid="agent-flow-keep-working">
            Keep working
          </Button>
          <Button
            variant="secondary"
            onClick={() => void handleCheckAgain()}
            disabled={checking}
            data-testid="agent-flow-check-again"
          >
            {checking ? "Checking…" : "Check again"}
          </Button>
        </div>
      </div>
    );
  }

  if (step === "failed") {
    return (
      <div
        className="mx-auto max-w-xl rounded-lg border border-red-200 bg-red-50 p-5 text-center"
        data-testid="agent-flow-failed"
      >
        <p className="text-sm font-semibold text-gray-900">The payment didn&apos;t go through</p>
        <p className="mt-1 text-sm text-gray-700">Nothing was charged.</p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          <Button size="lg" onClick={() => void handleReopen()} data-testid="agent-flow-try-again">
            Try again
          </Button>
          <Button variant="secondary" onClick={() => onBack()} data-testid="agent-flow-back">
            Back to plans
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="mx-auto max-w-xl rounded-lg border border-primary/30 bg-primary/5 p-5 text-center"
      data-testid="agent-flow-waiting"
    >
      <p className="text-sm font-semibold text-gray-900">
        Finish your purchase in the browser window that just opened
      </p>
      <p className="mx-auto mt-1 max-w-sm text-xs text-gray-600">
        <span className="font-medium text-gray-800">{item}</span>. This screen updates when Stripe
        confirms the payment. Nothing is charged until you complete checkout.
      </p>
      {reopened && (
        <p className="mt-2 text-xs text-primary" role="status">
          Checkout opened again in your browser.
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
        <Button variant="secondary" onClick={() => void handleReopen()} data-testid="agent-flow-reopen">
          Reopen checkout
        </Button>
        <Button variant="secondary" onClick={() => onBack()} data-testid="agent-flow-cancel">
          Cancel
        </Button>
      </div>
    </div>
  );
}

export default AgentSubscribeFlow;
