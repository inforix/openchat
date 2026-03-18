import React, { type ReactNode } from "react";

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>
        <div className="site-frame">{children}</div>
        <style jsx global>{`
          :root {
            color-scheme: light;
            --page: #f4f0e8;
            --panel: rgba(255, 252, 246, 0.92);
            --panel-border: rgba(34, 34, 34, 0.14);
            --ink: #161616;
            --muted: #625b53;
            --accent: #165d52;
            --accent-soft: rgba(22, 93, 82, 0.12);
            --danger: #a13a30;
            --danger-soft: rgba(161, 58, 48, 0.12);
            --shadow: 0 24px 80px rgba(22, 18, 14, 0.08);
            --serif: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
            --sans: "Avenir Next", "Segoe UI", sans-serif;
            --mono: "SFMono-Regular", "Menlo", monospace;
          }

          * {
            box-sizing: border-box;
          }

          html,
          body {
            margin: 0;
            min-height: 100%;
            background:
              radial-gradient(circle at top left, rgba(22, 93, 82, 0.12), transparent 28%),
              linear-gradient(180deg, #fbf8f1 0%, var(--page) 100%);
            color: var(--ink);
            font-family: var(--sans);
          }

          body::before {
            content: "";
            position: fixed;
            inset: 0;
            pointer-events: none;
            background-image: linear-gradient(
              rgba(22, 22, 22, 0.02) 1px,
              transparent 1px
            );
            background-size: 100% 32px;
            opacity: 0.5;
          }

          a {
            color: inherit;
          }

          .site-frame {
            width: min(1120px, calc(100% - 32px));
            margin: 0 auto;
            padding: 24px 0 40px;
          }

          .screen-shell {
            display: grid;
            gap: 18px;
          }

          .masthead {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            align-items: end;
            padding-bottom: 16px;
            border-bottom: 1px solid rgba(22, 22, 22, 0.12);
          }

          .masthead h1 {
            margin: 0;
            font-family: var(--serif);
            font-size: clamp(2.1rem, 5vw, 4rem);
            line-height: 0.95;
            letter-spacing: -0.04em;
          }

          .masthead p {
            margin: 8px 0 0;
            color: var(--muted);
            max-width: 42rem;
          }

          .masthead-tag {
            color: var(--muted);
            text-transform: uppercase;
            letter-spacing: 0.18em;
            font-size: 0.72rem;
            font-family: var(--mono);
          }

          .panel {
            background: var(--panel);
            border: 1px solid var(--panel-border);
            box-shadow: var(--shadow);
          }

          .shell-panel {
            padding: 20px;
            border-radius: 24px;
          }

          .section-kicker {
            margin-bottom: 12px;
            color: var(--muted);
            text-transform: uppercase;
            letter-spacing: 0.18em;
            font-size: 0.72rem;
            font-family: var(--mono);
          }

          .panel-header {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            align-items: start;
            margin-bottom: 16px;
          }

          .panel-actions {
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
            justify-content: flex-end;
          }

          .panel-header h1,
          .panel-header h2 {
            margin: 0;
            font-family: var(--serif);
            font-size: clamp(1.5rem, 2vw, 2.2rem);
            line-height: 1;
            letter-spacing: -0.03em;
          }

          .lede {
            margin: 8px 0 0;
            color: var(--muted);
            max-width: 36rem;
          }

          .host-switcher {
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
            margin-bottom: 16px;
          }

          .host-pill,
          .utility-button,
          .action-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border: 1px solid rgba(22, 22, 22, 0.16);
            background: #fffdf8;
            color: var(--ink);
            cursor: pointer;
            text-decoration: none;
            transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
          }

          .host-pill {
            min-width: 180px;
            padding: 12px 14px;
            border-radius: 18px;
            text-align: left;
            display: grid;
            gap: 6px;
          }

          .host-pill small,
          .bot-meta,
          .session-stamp,
          .message-role {
            color: var(--muted);
            font-family: var(--mono);
            font-size: 0.78rem;
          }

          .host-pill.is-selected,
          .host-pill:hover,
          .utility-button:hover,
          .action-button:hover {
            transform: translateY(-1px);
            border-color: rgba(22, 93, 82, 0.5);
            background: var(--accent-soft);
          }

          .utility-button,
          .action-button {
            padding: 12px 16px;
            border-radius: 999px;
            font-weight: 600;
          }

          .utility-button:disabled,
          .action-button:disabled {
            cursor: not-allowed;
            opacity: 0.56;
            transform: none;
          }

          .bot-roster,
          .message-log {
            margin: 0;
            padding: 0;
            list-style: none;
            display: grid;
            gap: 10px;
          }

          .bot-row,
          .message-row {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            padding: 14px 16px;
            border-radius: 18px;
            border: 1px solid rgba(22, 22, 22, 0.08);
            background: rgba(255, 255, 255, 0.72);
          }

          .bot-row strong,
          .message-row p {
            display: block;
          }

          .bot-row p,
          .message-row p {
            margin: 4px 0 0;
            color: var(--muted);
          }

          .bot-row.is-empty {
            color: var(--muted);
          }

          .bot-meta,
          .session-stamp {
            display: grid;
            gap: 4px;
            text-align: right;
          }

          .stack-form {
            display: grid;
            gap: 14px;
          }

          .stack-form label {
            display: grid;
            gap: 8px;
            font-weight: 600;
          }

          .stack-form input {
            width: 100%;
            padding: 12px 14px;
            border-radius: 14px;
            border: 1px solid rgba(22, 22, 22, 0.16);
            background: rgba(255, 255, 255, 0.9);
            font: inherit;
          }

          .status-banner {
            margin: 16px 0 0;
            padding: 12px 14px;
            border-radius: 16px;
            border: 1px solid rgba(22, 22, 22, 0.08);
          }

          .status-banner.is-success,
          .read-only-chip {
            background: var(--accent-soft);
            color: var(--accent);
          }

          .status-banner.is-error {
            background: var(--danger-soft);
            color: var(--danger);
          }

          .status-banner.is-muted {
            background: rgba(22, 22, 22, 0.05);
            color: var(--muted);
          }

          .read-only-chip {
            align-self: center;
            border-radius: 999px;
            padding: 8px 12px;
            font-family: var(--mono);
            font-size: 0.78rem;
          }

          .roster-preview {
            margin-top: 20px;
            padding-top: 18px;
            border-top: 1px solid rgba(22, 22, 22, 0.08);
          }

          .route-strip {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            color: var(--muted);
            font-family: var(--mono);
            font-size: 0.8rem;
          }

          @media (max-width: 720px) {
            .site-frame {
              width: min(100% - 20px, 1120px);
            }

            .panel-header,
            .bot-row,
            .message-row,
            .masthead {
              flex-direction: column;
            }

            .bot-meta,
            .session-stamp {
              text-align: left;
            }
          }
        `}</style>
      </body>
    </html>
  );
}
