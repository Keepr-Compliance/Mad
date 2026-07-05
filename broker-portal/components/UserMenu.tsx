'use client';

import { useState, useRef, useEffect } from 'react';
import { LogOut } from 'lucide-react';
import { Badge } from '@keepr/design-system';

interface UserMenuProps {
  email: string;
  name?: string;
  role?: string;
}

function getInitials(name?: string, email?: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  if (email) {
    return email.slice(0, 2).toUpperCase();
  }
  return '??';
}

function formatRole(role?: string): string {
  if (!role) return 'Member';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export default function UserMenu({ email, name, role }: UserMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const initials = getInitials(name, email);
  const displayName = name || email.split('@')[0];

  return (
    <div className="relative" ref={menuRef}>
      {/* Avatar Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-center w-10 h-10 rounded-full bg-primary-600 text-white font-medium text-sm hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 transition-colors"
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        {initials}
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 rounded-lg shadow-lg bg-white ring-1 ring-black ring-opacity-5 z-50">
          <div className="p-4 border-b border-gray-100">
            {/* User Info */}
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-12 h-12 rounded-full bg-primary-600 text-white font-medium">
                {initials}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {displayName}
                </p>
                <p className="text-xs text-gray-500 truncate">
                  {email}
                </p>
                <Badge hue="primary" size="sm" className="mt-1">
                  {formatRole(role)}
                </Badge>
              </div>
            </div>
          </div>

          {/* Menu Items */}
          <div className="py-1">
            <a
              href="/auth/logout"
              className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors"
            >
              <LogOut className="h-4 w-4 text-gray-400" />
              Sign out
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
