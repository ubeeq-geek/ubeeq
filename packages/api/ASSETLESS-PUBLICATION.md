# Publishing Works without assets

`PublicationService` retains its default requirement for at least one ready asset.
A product composition can explicitly supply a fourth constructor argument:
`{ allowWithoutAssets: work => /* product decision */ }`. Only a literal `true`
permits an empty attachment set. This is a trusted server-side option, not a
request-body field. The callback receives a cloned Work and cannot alter the
snapshot subsequently passed to publication admission or persistence.

Actor authorization, product admission, revision checks, atomic receipt/audit
creation and idempotent replay remain required. Any attached assets must still
belong to the creator and be ready, even when the empty-set option is enabled.
Products own allowed content kinds, text/body eligibility, safe rendering and
public delivery. This option neither renders nor grants access to content.
