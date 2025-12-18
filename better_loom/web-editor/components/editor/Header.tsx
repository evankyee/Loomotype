'use client';

import { useState } from 'react';
import { Undo2, Redo2, Download, Users, ChevronRight } from 'lucide-react';

interface HeaderProps {
  projectName: string;
  onProjectNameChange: (name: string) => void;
  onPersonalize?: () => void;
}

export function Header({ projectName, onProjectNameChange, onPersonalize }: HeaderProps) {
  const [isEditing, setIsEditing] = useState(false);

  return (
    <header className="h-12 border-b border-border-subtle bg-surface flex items-center justify-between px-3">
      {/* Left section - Logo and project name */}
      <div className="flex items-center gap-1">
        {/* Logo - clean, minimal */}
        <div className="flex items-center gap-2 pr-2">
          <div className="w-6 h-6 rounded-md bg-primary/10 flex items-center justify-center">
            <div className="w-3 h-3 rounded-full bg-primary" />
          </div>
          <span className="text-sm font-semibold text-foreground">Soron</span>
        </div>

        {/* Breadcrumb separator */}
        <ChevronRight className="w-3.5 h-3.5 text-foreground-muted" />

        {/* Project name - editable */}
        <div className="flex items-center">
          {isEditing ? (
            <input
              type="text"
              value={projectName}
              onChange={(e) => onProjectNameChange(e.target.value)}
              onBlur={() => setIsEditing(false)}
              onKeyDown={(e) => e.key === 'Enter' && setIsEditing(false)}
              className="bg-transparent text-sm text-foreground-secondary border-b border-primary outline-none px-1 py-0.5 min-w-[120px]"
              autoFocus
            />
          ) : (
            <button
              onClick={() => setIsEditing(true)}
              className="text-sm text-foreground-secondary hover:text-foreground px-1 py-0.5 rounded transition-colors duration-150"
            >
              {projectName}
            </button>
          )}
        </div>
      </div>

      {/* Right section - Actions */}
      <div className="flex items-center gap-1">
        {/* Undo/Redo - subtle icon buttons */}
        <div className="flex items-center border-r border-border-subtle pr-2 mr-1">
          <button
            className="p-1.5 rounded text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-all duration-150"
            title="Undo"
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <button
            className="p-1.5 rounded text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-all duration-150"
            title="Redo"
          >
            <Redo2 className="w-4 h-4" />
          </button>
        </div>

        {/* Export button - secondary style */}
        <button className="h-7 px-3 text-xs font-medium text-foreground bg-surface-elevated border border-border rounded-md hover:bg-surface-hover hover:border-foreground-muted/20 transition-all duration-150 flex items-center gap-1.5">
          <Download className="w-3.5 h-3.5" />
          Export
        </button>

        {/* Personalize button - primary action */}
        <button
          onClick={onPersonalize}
          className="h-7 px-3 text-xs font-medium text-white bg-primary rounded-md hover:bg-primary-hover active:bg-primary-muted transition-all duration-150 flex items-center gap-1.5"
        >
          <Users className="w-3.5 h-3.5" />
          Personalize
        </button>
      </div>
    </header>
  );
}
