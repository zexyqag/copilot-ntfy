# Copilot Ntfy Notifier

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/MrCarrotLabs.copilot-ntfy?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=MrCarrotLabs.copilot-ntfy)
[![Open VSX](https://img.shields.io/open-vsx/v/MrCarrotLabs/copilot-ntfy?label=Open%20VSX)](https://open-vsx.org/extension/MrCarrotLabs/copilot-ntfy)

**Stop babysitting Copilot.** Start a long agent task, walk away, and get a push notification on your phone (and smart watch) the moment it finishes.

This VS Code extension watches the Copilot Chat log in the background and currently sends [ntfy.sh](https://ntfy.sh) notifications only for job completion. Other notification types are temporarily disabled while their heuristics are being reworked.

| When            | You get notified          |
| --------------- | ------------------------- |
| ✅ **Job done** | Copilot finished the task |

## Features

- **Phone notifications via ntfy** — works with any ntfy.sh topic or self-hosted server.
- **Secure ntfy authentication** — supports Bearer tokens and Basic auth using VS Code secret storage.
- **Built-in test notification** — verify ntfy setup immediately from the Command Palette.
- **Completion-only notifications for now** — wait-state and failure notifications are temporarily disabled while their behavior is being revised.
- **Job details included** — model name and elapsed duration in every notification.
- **Multi-window safe** — deduplicates notifications across multiple VS Code windows.
- **Status bar indicator** — shows at a glance whether the watcher is active.
- **Configurable** — poll interval, ntfy server URL, topic, and auto-start on launch.

## Requirements

- [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) extension installed and signed in.
- An [ntfy.sh](https://ntfy.sh) account (or self-hosted ntfy server) with a topic set up.
- An app on your phone subscribed to the same topic (ntfy is available for [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) and [iOS](https://apps.apple.com/app/ntfy/id1625396347)).
- macOS, Linux, or Windows.

## Getting Started

1. Install the extension.
2. Open the Command Palette (`⇧⌘P`) and run **Copilot Ntfy: Set ntfy Topic**.
3. Enter your ntfy topic (e.g. `my-copilot-jobs`).
4. If your ntfy server requires auth, run **Copilot Ntfy: Configure ntfy Auth** and choose Bearer token or Basic auth.
5. Optionally run **Copilot Ntfy: Send Test Notification** to verify delivery immediately.
6. Watching starts automatically. You'll see `Copilot Ntfy: 👁` in the status bar.

## Configuration

| Setting                      | Default           | Description                                              |
| ---------------------------- | ----------------- | -------------------------------------------------------- |
| `copilotNtfy.ntfyServer`     | `https://ntfy.sh` | ntfy server URL (use your self-hosted URL if applicable) |
| `copilotNtfy.ntfyTopic`      | _(empty)_         | ntfy topic to publish notifications to                   |
| `copilotNtfy.ntfyAuthMethod` | `none`            | ntfy auth mode; credentials are managed via secret storage |
| `copilotNtfy.pollIntervalMs` | `5000`            | How often to poll the log file in milliseconds           |
| `copilotNtfy.autoStart`      | `false`           | Automatically start watching when VS Code opens          |

## Commands

| Command                        | Description                         |
| ------------------------------ | ----------------------------------- |
| `Copilot Ntfy: Start Watching` | Begin watching the Copilot Chat log |
| `Copilot Ntfy: Stop Watching`  | Stop watching                       |
| `Copilot Ntfy: Set ntfy Topic` | Set or update the ntfy topic        |
| `Copilot Ntfy: Configure ntfy Auth` | Store or clear ntfy credentials securely |
| `Copilot Ntfy: Send Test Notification` | Send a manual test notification to your ntfy topic |
| `Copilot Ntfy: Open Settings`  | Open the extension settings page    |

## How it Works

The extension polls the **GitHub Copilot Chat** log file. The log directory is resolved automatically per platform:

| OS      | Log directory                             |
| ------- | ----------------------------------------- |
| macOS   | `~/Library/Application Support/Code/logs` |
| Windows | `%APPDATA%\Code\logs`                     |
| Linux   | `~/.config/Code/logs`                     |

It watches for `ToolCallingLoop` stop events to detect job completion. The extension still tracks additional wait-state signals internally, but those notifications are currently suppressed until the related heuristics are revisited.

It then reads the relevant request line to extract the model name and duration, and POSTs to your ntfy server.

No Copilot API calls are made; the extension is purely passive and read-only with respect to Copilot itself.

## Privacy

All notification traffic goes directly from your machine to your configured ntfy server. If you enable ntfy authentication, the credential is stored in VS Code secret storage instead of plaintext settings. No data is sent to any third party by this extension.

## License

[MIT](LICENSE)
