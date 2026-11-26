# Rust reference web Lambda

The native Function URL handler serves the reference workspace, website editor,
and extension contracts. It forwards the existing API routes to the configured
reference API with the same request and response header policy.

The CI build renders browser assets through the existing reference web build
handler and packages them alongside the binary. The deployed Lambda runs the
Rust bootstrap and does not need Node.js. The API, worker, and migration
functions are deployed separately by the stack.

Review the x86-64 Linux artifact from the Rust reference web Lambda workflow.
Set CDK context `rustWebAssetPath` or `UBEEQ_RUST_WEB_ASSET_PATH` to the ZIP or
its extracted directory when synthesizing a reference cell. Keep
`UBEEQ_REFERENCE_WEB_API_URL` pointed at that cell's reviewed API origin.
