import type { ReactNode } from 'react';
import { openExternal } from '../platform/open';

/**
 * An anchor that works in both shells.
 *
 * It keeps a real `href` so the link is inspectable and keyboard-reachable,
 * but routes the actual open through the platform helper, because inside the
 * Tauri window a plain `target="_blank"` goes nowhere.
 */
export function ExternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className={className}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => {
        event.preventDefault();
        // Rows are clickable; a link click must not also trigger the row.
        event.stopPropagation();
        void openExternal(href);
      }}
    >
      {children}
    </a>
  );
}
