# Telegram notification

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/telegram-notification/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/telegram-notification/README.zh-CN.md)

## Purpose

Send post-save text notifications based on the current accumulated decision, optionally including previous plugin details.

`builtin.telegram-notification` · `processor` · `post_save`

## Configuration

The core fills defaults when saving an instance. “Required” means a value must be supplied because no default is available.

### `post_save`

| Field | Meaning | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `botToken` | Bot token | Yes | — | secret |
| `chatId` | Chat ID | Yes | — | — |
| `statuses` | Notify on statuses | No | `["block", "delete"]` | `pass`, `block`, `delete` |
| `includeDetails` | Include previous step details | No | `false` | — |
| `timeoutMs` | Timeout (ms) | No | `10000` | ≥ 100; ≤ 120000 |

No request parameters.

## Usage example

Allow the bot to send messages to the target chat. Place this instance after moderation, at the end of the post-save pipeline. The example notifies only for block or delete decisions and includes available moderation details. Verify with a test image that triggers a moderation decision.

```json
{
  "botToken": "123456:YOUR_BOT_TOKEN",
  "chatId": "-1001234567890",
  "statuses": [
    "block",
    "delete"
  ],
  "includeDetails": true
}
```

## Behavior and limitations

Messages contain the current accumulated status, file ID and URL. Optional details come from `previousResults`; long text is truncated to one message, link previews are disabled and no image is sent. An unmatched status returns `pass` with `{ "sent": false }`; success returns `pass` with the message ID, without overriding prior decisions. A `delete` notification describes the current decision, not completed replica cleanup. Unknown network outcomes are not automatically resent, but re-executing the pipeline may duplicate notifications.
