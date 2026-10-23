# Explicit thread API (#2)

This is a breaking change: callers must create a thread with `POST /threads`
before using any thread-specific API. Sending to an arbitrary ID no longer
creates a conversation. Use the returned ID for messages, resume, pending
approvals, history and deletion.

The live HTTP server requires PostgreSQL configured through
`POSTGRES_CONNECTION_STRING`, the current model/classifier settings, and
`WINGMAN_API_TOKEN`; see the [README setup](../README.md#quick-start). All endpoints require
`Authorization: Bearer <token>`. Missing or invalid credentials return `401`.

## Create, list, read and delete

| Request | Success | Contract |
| --- | --- | --- |
| `POST /threads` with JSON `{}` | `201` | `{ "id": "<generated-id>" }` |
| `GET /threads?limit=20&cursor=<cursor>` | `200` | `{ "threads": [{ "id", "title", "createdAt", "updatedAt" }], "nextCursor": "..." }` |
| `GET /threads/:id/messages?limit=50&cursor=<cursor>` | `200` | `{ "messages": [...], "nextCursor": "..." }` |
| `DELETE /threads/:id` | `204` | Empty body; idempotent, including for an already absent valid ID. |

Omit `cursor` on the first request. Limits default to 20 for the catalogue and
50 for history; both accept integers from 1 through 100. `nextCursor` is `null`
when there are no more results. Pass returned cursors unchanged and use them
only with the corresponding endpoint (and, for history, the same thread).

The catalogue contains only threads explicitly created through this API. Old
checkpoint-only conversations, CLI conversations and scheduled job runs are
excluded. There is no automatic migration or import. Entries are ordered by
most recent `updatedAt`, with ID as a tie-breaker. Timestamps are ISO strings.
A newly created entry has the title `New conversation`. Its first user message
sets the title to the first 80 Unicode code points of the trimmed message;
later messages do not replace it. No model generates the title.

History returns the newest page first, with messages in chronological order
within each page. `nextCursor` walks toward older messages and pins the
checkpoint snapshot, so subsequent writes do not shift those older pages.
Prepend older pages when displaying a full conversation. Fetch without a
cursor to refresh the latest snapshot. An empty thread returns an empty array
and a null cursor.

Each history message has this shape:

```json
{
  "id": "message-id",
  "role": "assistant",
  "text": "",
  "toolCalls": [
    {
      "id": "tool-call-id",
      "name": "exec_bash_command",
      "args": { "command": "uptime" },
      "result": { "output": "System uptime: ...", "truncated": false }
    }
  ]
}
```

`role` is `user` or `assistant`. `toolCalls` is optional, as is each call's
`result` (for example, while awaiting approval). Results are attached to their
assistant tool call; raw tool-result messages and internal/system messages
are hidden. Output previews contain at most 10,000 UTF-16 code units, with
`truncated: true` when shortened. The SSE `tool_result` event contains `type: "tool_result"`, `name`,
`toolCallId`, `output` and `truncated`, using the same bounded preview.

## Existing turn and approval APIs

- `POST /threads/:id/messages` with `{ "message": "run uptime" }` streams the
  turn as SSE, ending with `approval` or `done`.
- `GET /threads/:id/pending` returns the pending approvals array.
- `POST /threads/:id/resume` with `{ "answers": { "<approval-id>": true } }`
  approves; use `false` to deny. Answer every pending approval by its ID.

A new user message still declines outstanding approvals before starting its
own turn. Use resume to answer the pending turn instead. Copy actual approval
IDs from the stream or pending response.

| Status | Meaning |
| --- | --- |
| `400` | Invalid body, thread ID, limit or cursor, including a history cursor for another thread or an unavailable snapshot. |
| `401` | Missing or invalid bearer token. |
| `404` | A valid ID was not created by `POST /threads`, or was deleted, for messages (send/history), resume or pending. DELETE remains idempotent. |
| `409` | Another send/resume/delete is active on the same thread; resume has nothing pending; or deletion is incomplete. |

Thread IDs accept 1–64 ASCII word characters or hyphens. Sending/resuming or
deleting during an active turn returns `409`. If deletion partially fails, a
durable deleting marker hides the entry from the catalogue and blocks normal
thread use with `409`; retry `DELETE` on the same ID to finish cleanup.

The API catalogue and LangGraph checkpoint store are distinct stores: the
catalogue tracks API thread metadata, while checkpoints hold conversation and
pending-turn state. Model configuration selects inference endpoints and is
separate from both stores; global graph memory is another shared store.
Deleting a thread removes its catalogue entry and checkpoint state. It does
not erase global memory or delete scheduled tasks.

## Curl walkthrough

Create a thread and copy its returned ID:

```bash
curl http://127.0.0.1:3000/threads \
  -H "Authorization: Bearer $WINGMAN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

export THREAD_ID='<thread-id>' # Replace with the actual response.id.

curl -N "http://127.0.0.1:3000/threads/$THREAD_ID/messages" \
  -H "Authorization: Bearer $WINGMAN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"run uptime"}'

curl "http://127.0.0.1:3000/threads/$THREAD_ID/pending" \
  -H "Authorization: Bearer $WINGMAN_API_TOKEN"

curl "http://127.0.0.1:3000/threads/$THREAD_ID/messages?limit=50" \
  -H "Authorization: Bearer $WINGMAN_API_TOKEN"

curl 'http://127.0.0.1:3000/threads?limit=20' \
  -H "Authorization: Bearer $WINGMAN_API_TOKEN"

curl -X DELETE "http://127.0.0.1:3000/threads/$THREAD_ID" \
  -H "Authorization: Bearer $WINGMAN_API_TOKEN"
```

## Bruno manual checks

Open `apps/server/bruno`, select `local`, and set its secret `token` to
`WINGMAN_API_TOKEN`. `threadId` starts empty: run **0 Create thread** first.
Its post-response script saves `res.getBody().id` with `bru.setEnvVar`.

1. Run **0 Create thread**, then **1 Pending** (initially `[]`).
2. Run **2 Send message**. If it pauses, run Pending again, then choose
   **3 Approve** or **4 Deny**. These are alternatives, not consecutive steps
   for the same approval. Send again to obtain another approval to test the
   other branch. The send script captures the first approval ID; for multiple
   approvals, supply all IDs from Pending in the resume body.
3. Run **5 History**, then **6 List threads**. Check the title and message/tool
   result shapes. To check pagination, lower the limit and append the returned
   `cursor` query parameter manually. Write a new message between history
   page requests and confirm older pages still use the original snapshot.
4. Run **7 Delete thread** twice; both should return `204`. History and Pending
   for that ID should now return `404`, and List should omit it.
5. Run **errors/Unknown thread** independently for `404`, and
   **errors/No token** for `401`. For **errors/Empty message**, create a thread
   first and expect `400`.
6. For **errors/Resume with nothing pending**, run **0 Create thread**
   immediately beforehand, before sending or requesting approvals. Expect
   `409` on this fresh, existing thread. No pre-request creation is needed.

Run these requests interactively; a blind collection run would execute both
approval branches and the error cases on the same evolving thread. The
[automated testing guide](testing.md) covers the existing test commands and
isolation strategy. Live Bruno checks require the configured server and its
external services.

Per-thread mutation locking currently applies within one server process. Running
multiple API workers against the same database requires shared locking.
