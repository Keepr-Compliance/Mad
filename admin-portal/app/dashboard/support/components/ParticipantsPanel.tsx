'use client';

/**
 * ParticipantsPanel - Support Ticket Detail Sidebar
 *
 * Shows current participants (CC/Watcher) and allows adding/removing them.
 * Only agents can manage participants.
 */

import { useState } from 'react';
import { addParticipant, removeParticipant } from '@/lib/support-queries';
import type { SupportTicketParticipant, ParticipantRole } from '@/lib/support-types';

interface ParticipantsPanelProps {
  ticketId: string;
  participants: SupportTicketParticipant[];
  onUpdated: () => void;
}

export function ParticipantsPanel({ ticketId, participants, onUpdated }: ParticipantsPanelProps) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<ParticipantRole>('cc');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function handleAdd() {
    if (!email.trim()) return;
    setAdding(true);
    setError(null);

    try {
      await addParticipant(ticketId, email.trim(), name.trim() || undefined, role);
      setEmail('');
      setName('');
      setShowForm(false);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add participant');
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(participantId: string) {
    setRemoving(participantId);
    setError(null);

    try {
      await removeParticipant(participantId);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove participant');
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="px-4 py-3">
      <label className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 block">
        Participants
      </label>

      {error && (
        <div className="text-xs text-red-600 mb-2">{error}</div>
      )}

      {/* Participant list */}
      {participants.length === 0 ? (
        <p className="text-xs text-gray-400 mb-2">No participants added</p>
      ) : (
        <ul className="space-y-1.5 mb-2">
          {participants.map((p) => (
            <li key={p.id} className="flex items-center justify-between text-xs">
              <div className="min-w-0">
                <span className="text-gray-700 truncate block">
                  {p.name || p.email}
                </span>
                {p.name && (
                  <span className="text-gray-400 truncate block">{p.email}</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0 ml-2">
                <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                  p.role === 'cc'
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-600'
                }`}>
                  {p.role.toUpperCase()}
                </span>
                <button
                  onClick={() => handleRemove(p.id)}
                  disabled={removing === p.id}
                  className="text-gray-400 hover:text-red-500 disabled:opacity-50"
                  title="Remove participant"
                >
                  &times;
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Add form */}
      {showForm ? (
        <div className="space-y-1.5 bg-gray-50 rounded p-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            className="w-full text-xs text-gray-900 border border-gray-300 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-primary-500"
          />
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional)"
            className="w-full text-xs text-gray-900 border border-gray-300 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-primary-500"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as ParticipantRole)}
            className="w-full text-xs text-gray-900 border border-gray-300 rounded px-2 py-1 bg-white"
          >
            <option value="cc">CC</option>
            <option value="watcher">Watcher</option>
          </select>
          <div className="flex gap-1">
            <button
              onClick={handleAdd}
              disabled={adding || !email.trim()}
              className="text-xs px-2 py-1 bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50"
            >
              {adding ? 'Adding...' : 'Add'}
            </button>
            <button
              onClick={() => { setShowForm(false); setError(null); }}
              className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="text-xs text-primary-600 hover:text-primary-700 font-medium"
        >
          + Add Participant
        </button>
      )}
    </div>
  );
}
