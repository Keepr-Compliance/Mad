/**
 * TransactionTabs Component
 * Tab navigation for transaction details view
 *
 * Tab order: Overview | Texts | Emails | Attachments
 */
import React from "react";
import type { TransactionTab } from "../types";

interface TransactionTabsProps {
  activeTab: TransactionTab;
  conversationCount: number;
  emailCount: number;
  onTabChange: (tab: TransactionTab) => void;
}

export function TransactionTabs({
  activeTab,
  conversationCount: _conversationCount,
  emailCount: _emailCount,
  onTabChange,
}: TransactionTabsProps): React.ReactElement {
  return (
    <div className="flex-shrink-0 border-b border-gray-200 px-3 sm:px-6 overflow-x-auto scrollbar-hide">
      <div className="flex gap-1 sm:gap-4">
        <button
          onClick={() => onTabChange("overview")}
          className={`px-2 sm:px-4 py-2.5 sm:py-3 font-medium text-sm transition-all whitespace-nowrap ${
            activeTab === "overview"
              ? "border-b-2 border-green-500 text-green-600"
              : "text-gray-600 hover:text-gray-900"
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => onTabChange("messages")}
          className={`px-2 sm:px-4 py-2.5 sm:py-3 font-medium text-sm transition-all flex items-center gap-1 sm:gap-1.5 whitespace-nowrap ${
            activeTab === "messages"
              ? "border-b-2 border-green-500 text-green-600"
              : "text-gray-600 hover:text-gray-900"
          }`}
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
          Texts
        </button>
        <button
          onClick={() => onTabChange("emails")}
          className={`px-2 sm:px-4 py-2.5 sm:py-3 font-medium text-sm transition-all flex items-center gap-1 sm:gap-1.5 whitespace-nowrap ${
            activeTab === "emails"
              ? "border-b-2 border-green-500 text-green-600"
              : "text-gray-600 hover:text-gray-900"
          }`}
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
          Emails
        </button>
{/* Contacts tab removed - contacts now shown in Overview tab
        <button
          onClick={() => onTabChange("contacts")}
          className={`px-4 py-3 font-medium text-sm transition-all ${
            activeTab === "contacts"
              ? "border-b-2 border-green-500 text-green-600"
              : "text-gray-600 hover:text-gray-900"
          }`}
        >
          Roles & Contacts
        </button>
*/}
        {/* BACKLOG-322: unified Attachments tab (email + text) */}
        <button
          onClick={() => onTabChange("attachments")}
          data-testid="tab-attachments"
          className={`px-2 sm:px-4 py-2.5 sm:py-3 font-medium text-sm transition-all flex items-center gap-1 sm:gap-1.5 whitespace-nowrap ${
            activeTab === "attachments"
              ? "border-b-2 border-green-500 text-green-600"
              : "text-gray-600 hover:text-gray-900"
          }`}
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
            />
          </svg>
          Attachments
        </button>
      </div>
    </div>
  );
}
