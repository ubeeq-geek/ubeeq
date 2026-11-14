# Work mutation authority

The existing Work HTTP create, edit and delete routes recheck current Creator
custody and actor permissions inside their accepting repository transaction.
The check also applies to a keyed create's saved receipt recovery. An earlier
session or role lookup cannot authorize a later content commit.

Open-core defaults require the current Creator owner and retain that Creator's
revision condition. Multi-tenant hosts supply `workAuthorization.authorizeMutation`
to check current membership and retain both membership and the exact Creator
revision supplied by core until commit. A true response must establish those
conditions in the supplied transaction on the same repositories.
Hosts can return an expected HTTP conflict with the exported `WorkIntakeError`.

`createIntakeWork` is a trusted internal writer, not an authentication API. HTTP
composition always supplies its transaction-bound authorization callback. Other
trusted callers remain responsible for their own accepting authority. Work and
request receipts keep their existing identities, and replay never recreates a
deleted or edited Work. Deletion retains the existing collection lifecycle fence.

This correction does not certify publication withdrawal, import, account/session
revocation, migration holds, or a complete preparation content bridge. Those
authorities require their own transaction and acceptance coverage.
