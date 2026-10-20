# Model routing diagnostics

The classifier chooses `fast` or `powerful` from the latest human message.
The CLI displays the selected model and probabilities for every candidate:

```text
🧭 fast — fast: 51.13%, powerful: 48.87%
```

These values describe the classifier's preference between routes. They do not
measure how likely the selected model is to answer correctly. Only display
values are rounded; the API retains the original numbers.

## Route event

The server forwards core's `route` event on the existing SSE stream:

```json
{
  "type": "route",
  "choice": "fast",
  "confidence": 0.0003665156881398346,
  "probabilities": {
    "fast": 0.5112700443976795,
    "powerful": 0.4887299556023205
  }
}
```

`probabilities` is an additive, optional field so older saved routing state
remains usable. Clients with strict event schemas should allow it. If an older
event lacks probabilities, the CLI says `probabilities unavailable`; it does
not infer scores from confidence. Positive probabilities below 0.01% display
as `<0.01%` to distinguish them from exact zero.

## Confidence and errors

Confidence is a separate, backend-defined value. Zero is a valid response.
Previously the CLI showed confidence with two decimal places, so a value such
as `0.0003665156881398346` appeared as `0.00`. This was reproduced locally with
Ollama 0.40.6 and `tev1:0.8b`; it does not establish the cause of the earlier
API response containing an exact zero.

The installed TypeSafe middleware selects the returned `choice`; it does not
apply a confidence threshold or silently fall back to another model. HTTP,
connection, timeout and response-validation failures propagate as errors.
This display change does not change those routing or error behaviours.

## Classifier endpoint

`DECISIONS_MODEL_BASE_URL` must identify a server supporting
`POST /v1/systemone`, without including `/v1` in the configured base URL. The
client appends that path. Compatible Ollama versions can serve it locally;
port 11434 alone does not establish whether a particular installation supports
that endpoint. The classifier endpoint differs from the chat models'
OpenAI-compatible `/v1` base URL.

## Verification

Automated tests cover CLI formatting, unchanged zero and small positive
confidence values, probability preservation in core events and HTTP SSE,
and compatibility with events missing probabilities. Run `npm test` from
the repository root. See [Automated tests](testing.md).
