# Retained creator-content storage

`DynamoRetainedCreatorContent` shares the existing rich creator-content repository.
It preserves stored keys, payload fields, logical revisions, timestamps, alias
claims and restore visibility. Work readiness remains separate from publication
state, intents, copy/disclosure history and provider bindings. This repository
does not flatten those records into the compact reference API model.

The record model is generic. Hosts retain their narrower destination types and
their complete typed product metadata. Unknown extension fields in the lower
storage constraint remain opaque and pass through without interpretation.

Hosts must bind the real disclosure/projection, attachment, alias and restore
guards. The typed transport binds each command to the host's existing SDK and
transaction wrapper. This is necessary when a host intercepts its own SDK's
command constructors; loading another SDK copy must not bypass that wrapper.
Missing bindings or transport methods fail during construction.

The host owns authentication, current actor conditions, table/custody isolation,
leases and the accepting transaction. The extracted repository preserves its
existing Creator lifecycle condition; that condition alone does not authenticate
an actor. No serving composition or legacy writer is switched by this package.
