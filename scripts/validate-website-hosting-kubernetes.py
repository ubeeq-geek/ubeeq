"""Offline contract checks; runtime pod rescheduling is a separate acceptance gate."""
from pathlib import Path
import yaml
resources = list(yaml.safe_load_all(Path('deployments/kubernetes/website-hosting/hosting.yaml').read_text()))
by_kind = {r['kind']: r for r in resources}
assert by_kind['PersistentVolumeClaim']['spec']['accessModes'] == ['ReadWriteOnce']
deployment = by_kind['Deployment']['spec']
assert deployment['replicas'] == 1 and deployment['strategy']['type'] == 'Recreate'
pod = deployment['template']['spec']
assert pod['securityContext']['runAsNonRoot']
assert pod['initContainers'][0]['volumeMounts'][0]['name'] == 'data'
containers = {c['name']: c for c in pod['containers']}
assert set(containers) == {'api', 'publisher', 'static'}
static = containers['static']['volumeMounts']
assert len(static) == 1 and static[0]['readOnly'] and static[0]['subPath'] == 'public-releases'
assert static[0]['mountPath'] == '/data/public-releases'
assert pod['volumes'][0]['persistentVolumeClaim']['claimName'] == by_kind['PersistentVolumeClaim']['metadata']['name']
print('Kubernetes manifest contracts passed; this does not verify a storage driver or rescheduling.')
