# Local request limiting

`LocalSlidingWindowRateLimiter` retains admitted request timestamps for each key
within a caller-selected sliding window. Denied requests do not extend the window.
The clock is injectable for deterministic tests. Products choose keys and limits;
this mechanism does not decide trusted client identity or proxy-header policy.

It is deliberately process-local: state resets on restart and is not shared across
Lambda execution environments or replicas. It must not be represented as a global
abuse-control or quota boundary. Hosted workloads require shared enforcement or a
gateway limit appropriate to the workload. Key cardinality is not bounded and
unused keys are retained, so untrusted high-cardinality traffic is not qualified.

Use stable key/window/threshold policies. Changing a key's window after old entries
have been discarded cannot recover that history. Clock behavior and HTTP integration
must also be qualified independently of the deterministic mechanism tests.
