'use client';

import { useState } from 'react';
import {
  Upload,
  FileText,
  Sparkles,
  Monitor,
  Video,
  Mic,
  Zap,
  PenLine,
  Image,
  Circle
} from 'lucide-react';

interface SidebarProps {
  onFileUpload: (file: File) => void;
  onStartRecording?: (mode: string) => void;
}

export function Sidebar({ onFileUpload, onStartRecording }: SidebarProps) {
  const [activeTab, setActiveTab] = useState<'media' | 'transcript' | 'personalize'>('media');

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFileUpload(file);
    }
  };

  const tabs = [
    { id: 'media', label: 'Media', icon: Upload },
    { id: 'transcript', label: 'Transcript', icon: FileText },
    { id: 'personalize', label: 'AI', icon: Sparkles },
  ] as const;

  return (
    <aside className="w-60 border-r border-border-subtle bg-surface flex flex-col">
      {/* Tabs - cleaner, more compact */}
      <div className="flex px-2 pt-2 gap-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded-md
                transition-all duration-150
                ${isActive
                  ? 'bg-surface-elevated text-foreground'
                  : 'text-foreground-muted hover:text-foreground-secondary hover:bg-surface-hover'
                }
              `}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Divider */}
      <div className="h-px bg-border-subtle mx-2 mt-2" />

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-3 scrollbar-thin">
        {activeTab === 'media' && (
          <MediaPanel onFileSelect={handleFileSelect} onStartRecording={onStartRecording} />
        )}
        {activeTab === 'transcript' && (
          <TranscriptPanel />
        )}
        {activeTab === 'personalize' && (
          <PersonalizePanel />
        )}
      </div>
    </aside>
  );
}

function MediaPanel({
  onFileSelect,
  onStartRecording
}: {
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onStartRecording?: (mode: string) => void;
}) {
  return (
    <div className="space-y-4">
      {/* Upload section */}
      <div>
        <label className="group flex flex-col items-center justify-center py-6 px-4 border border-dashed border-border rounded-lg hover:border-foreground-muted/40 hover:bg-surface-hover/50 transition-all duration-150 cursor-pointer">
          <div className="w-8 h-8 rounded-full bg-surface-elevated flex items-center justify-center mb-2 group-hover:bg-surface-hover transition-colors">
            <Upload className="w-4 h-4 text-foreground-muted" />
          </div>
          <span className="text-sm text-foreground-secondary">Upload video</span>
          <span className="text-xs text-foreground-muted mt-0.5">or drag and drop</span>
          <input
            type="file"
            accept="video/*"
            className="hidden"
            onChange={onFileSelect}
          />
        </label>
      </div>

      {/* Record section */}
      <div>
        <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide mb-2">Record</p>
        <div className="space-y-1.5">
          <RecordButton
            icon={<Circle className="w-3 h-3 fill-current" />}
            iconBg="bg-accent/15 text-accent"
            title="Screen + Camera"
            subtitle="Record screen with webcam"
            onClick={() => onStartRecording?.('screen-camera')}
          />
          <RecordButton
            icon={<Monitor className="w-3.5 h-3.5" />}
            iconBg="bg-primary/15 text-primary"
            title="Screen Only"
            subtitle="Record your screen"
            onClick={() => onStartRecording?.('screen-only')}
          />
          <RecordButton
            icon={<Video className="w-3.5 h-3.5" />}
            iconBg="bg-success/15 text-success"
            title="Camera Only"
            subtitle="Record from webcam"
            onClick={() => onStartRecording?.('camera-only')}
          />
        </div>
      </div>
    </div>
  );
}

function RecordButton({
  icon,
  iconBg,
  title,
  subtitle,
  onClick
}: {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 p-2.5 rounded-md bg-surface-elevated hover:bg-surface-hover border border-transparent hover:border-border transition-all duration-150 text-left group"
    >
      <div className={`w-7 h-7 rounded-md flex items-center justify-center ${iconBg}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{title}</p>
        <p className="text-xs text-foreground-muted truncate">{subtitle}</p>
      </div>
    </button>
  );
}

function TranscriptPanel() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="w-10 h-10 rounded-full bg-surface-elevated flex items-center justify-center mb-3">
        <FileText className="w-5 h-5 text-foreground-muted" />
      </div>
      <p className="text-sm text-foreground-secondary">No transcript yet</p>
      <p className="text-xs text-foreground-muted mt-1 max-w-[180px]">
        Upload a video to generate an auto-transcript with word-level timestamps
      </p>
    </div>
  );
}

function PersonalizePanel() {
  return (
    <div className="space-y-4">
      {/* Info card */}
      <div className="p-3 rounded-lg bg-primary/5 border border-primary/10">
        <div className="flex items-center gap-2 mb-1">
          <Zap className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs font-medium text-foreground">AI Personalization</span>
        </div>
        <p className="text-xs text-foreground-muted leading-relaxed">
          Select text in the transcript or visual elements to personalize with AI
        </p>
      </div>

      {/* Quick actions */}
      <div>
        <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide mb-2">Quick Actions</p>
        <div className="space-y-1.5">
          <ActionButton
            icon={<Mic className="w-3.5 h-3.5" />}
            iconBg="bg-success/15 text-success"
            title="Clone Voice"
            subtitle="Extract voice from video"
          />
          <ActionButton
            icon={<PenLine className="w-3.5 h-3.5" />}
            iconBg="bg-primary/15 text-primary"
            title="Edit Transcript"
            subtitle="Modify speech with voice clone"
          />
          <ActionButton
            icon={<Image className="w-3.5 h-3.5" />}
            iconBg="bg-warning/15 text-warning"
            title="Replace Visual"
            subtitle="Swap selected elements"
          />
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  icon,
  iconBg,
  title,
  subtitle
}: {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  subtitle: string;
}) {
  return (
    <button className="w-full flex items-center gap-2.5 p-2.5 rounded-md bg-surface-elevated hover:bg-surface-hover border border-transparent hover:border-border transition-all duration-150 text-left">
      <div className={`w-7 h-7 rounded-md flex items-center justify-center ${iconBg}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{title}</p>
        <p className="text-xs text-foreground-muted truncate">{subtitle}</p>
      </div>
    </button>
  );
}
