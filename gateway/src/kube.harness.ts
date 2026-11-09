// `PNEUMA_SPACE_TEST_KUBECONTEXT=<context> npm run test:k8s` against the operator's cluster; the smoke tests skip when it is unset.
// The client gets the context's server and CA plus a 10-minute token for the ServiceAccount `pneuma-space-smoke` in
// `pneuma-space-apps`, which `deploy/kubernetes/90-smoke-rbac.yaml` creates after `00-namespaces.yaml` and `10-rbac.yaml` (the instance Pods run as
// `pneuma-space-app`); the context itself needs `create serviceaccounts/token` on it. Pod IPs that the host cannot reach: `PNEUMA_SPACE_TEST_POD_ROUTABLE=0`.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { KubeClient } from './kube.ts';

export const context = process.env.PNEUMA_SPACE_TEST_KUBECONTEXT;
export const skip = context ? false : 'PNEUMA_SPACE_TEST_KUBECONTEXT is unset; set it to a kubectl context to run the Kubernetes smoke';
export const NAMESPACE = 'pneuma-space-apps';

const kubectl = async (...args: string[]): Promise<string> =>
  (await promisify(execFile)('kubectl', ['--context', context!, ...args])).stdout;

export async function smokeClient(): Promise<KubeClient> {
  const config = JSON.parse(await kubectl('config', 'view', '--raw', '--minify', '-o', 'json'));
  const cluster = config.clusters[0].cluster;
  const ca = cluster['certificate-authority-data']
    ? Buffer.from(cluster['certificate-authority-data'], 'base64')
    : cluster['certificate-authority'] && (await readFile(cluster['certificate-authority']));
  const token = (await kubectl('-n', NAMESPACE, 'create', 'token', 'pneuma-space-smoke', '--duration=10m')).trim();
  return new KubeClient({ server: cluster.server, ca, token: async () => token, namespace: NAMESPACE });
}
