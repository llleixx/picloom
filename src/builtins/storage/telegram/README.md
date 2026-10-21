# Telegram Storage

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/telegram/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/telegram/README.zh-CN.md)

## Purpose

Store originals as Telegram bot documents without photo compression.

`builtin.telegram` · `storage`

## Configuration

Defaults initialize new drafts only; saving does not fill missing values. Required fields must be present in the submitted configuration. Fields marked “immutable” cannot be changed after creation.

| Field | Meaning | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `botToken` | Bot token | Yes | — | secret |
| `chatId` | Chat ID | Yes | — | immutable |
| `timeoutMs` | Timeout (ms) | Yes | `30000` | ≥ 100; ≤ 120000 |

No request parameters.

## Usage example

Create a bot, add it to the target chat and allow document sending. Set its token and numeric chat ID, then add the source to the upload profile’s storage group. Upload an image and check the chat document and public link.

```json
{
  "timeoutMs": 30000,
  "botToken": "123456:YOUR_BOT_TOKEN",
  "chatId": "-1001234567890"
}
```

## Behavior and limitations

The plugin limits files to 20,000,000 bytes to keep them downloadable through the hosted API it uses. Reads are proxied so token-bearing URLs are not exposed to clients. Enumeration and write recovery are not provided; unknown upload outcomes are not automatically resent. Deletion depends on message age and bot permissions. An explicit missing-message or “message can't be deleted” response (for example, after 48 hours) completes local cleanup without an error or retry. The latter does not confirm remote deletion or identify the exact reason for refusal. Authentication, network and other API errors still fail. Chat ID is immutable.
