'use client';

import { useState } from 'react';

interface HeaderProps {
  projectName: string;
  onProjectNameChange: (name: string) => void;
  onPersonalize?: () => void;
}

export function Header({ projectName, onProjectNameChange, onPersonalize }: HeaderProps) {
  const [isEditing, setIsEditing] = useState(false);

  return (
    <header className="h-14 border-b border-border bg-card flex items-center justify-between px-4">
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-primary-hover flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" />
            </svg>
          </div>
          <span className="font-semibold">Soron</span>
        </div>

        {/* Project name */}
        <div className="flex items-center gap-2 text-muted">
          <span>/</span>
          {isEditing ? (
            <input
              type="text"
              value={projectName}
              onChange={(e) => onProjectNameChange(e.target.value)}
              onBlur={() => setIsEditing(false)}
              onKeyDown={(e) => e.key === 'Enter' && setIsEditing(false)}
              className="bg-transparent border-b border-primary outline-none px-1"
              autoFocus
            />
          ) : (
            <button
              onClick={() => setIsEditing(true)}
              className="hover:text-foreground transition-colors"
            >
              {projectName}
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        {/* Undo/Redo */}
        <div className="flex items-center gap-1">
          <button className="p-2 rounded-lg hover:bg-card-hover text-muted hover:text-foreground transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
          </button>
          <button className="p-2 rounded-lg hover:bg-card-hover text-muted hover:text-foreground transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10h-10a8 8 0 00-8 8v2M21 10l-6 6m6-6l-6-6" />
            </svg>
          </button>
        </div>

        {/* Export button */}
        <button className="px-4 py-2 bg-gradient-to-r from-primary to-primary-hover text-white rounded-lg font-medium hover:opacity-90 transition-opacity">
          Export Video
        </button>

        {/* Create personalized versions */}
        <button
          onClick={onPersonalize}
          className="px-4 py-2 bg-accent text-white rounded-lg font-medium hover:opacity-90 transition-opacity flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
          Personalize
        </button>
      </div>
    </header>
  );
}
