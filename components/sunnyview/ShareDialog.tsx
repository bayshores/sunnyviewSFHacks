"use client";

export type ShareDialogProps = {
  shareUrl: string | null;
  shareSlug: string | null;
  onClose: () => void;
};

/** Modal showing the public `/s/:shareSlug` link with a copy button. */
export function ShareDialog({ shareUrl, shareSlug, onClose }: ShareDialogProps) {
  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="glass-card w-full max-w-md p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">Share</div>
          <button
            className="text-xs text-muted-foreground hover:text-foreground"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="glass-surface mt-3 rounded-lg p-4">
          {shareUrl ? (
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground">Public link</div>
              <div className="glass-surface break-all rounded-md p-2 text-xs text-foreground">
                {shareUrl}
              </div>
              <button
                type="button"
                className="rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(shareUrl);
                  } catch {
                    // ignore
                  }
                }}
              >
                Copy link
              </button>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              Share link not available yet.
            </div>
          )}
        </div>
        {shareSlug && (
          <div className="mt-3 text-xs text-muted-foreground">
            Share slug: <span className="text-foreground">{shareSlug}</span>
          </div>
        )}
      </div>
    </div>
  );
}
