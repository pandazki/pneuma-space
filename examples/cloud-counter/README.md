# Private cloud counter

This example uses [contract 2](../../docs/app-contract.md#cloud-profile-contract-2). It stores the count with conditional record commits and serves its page through the authenticated static route.

Start the [local cloud profile](../../cloud/README.md), create a deployment credential in its console, then publish from the repository root:

```sh
export PNEUMA_SPACE_ADMIN=http://localhost:8787
export PNEUMA_SPACE_TOKEN='<credential from the console>'
node cloud/cli/appctl.ts publish counter examples/cloud-counter
```

Open the application from the console. Add a count, remove the app, then publish it again. The count remains. To download its archive, remove it and run:

```sh
node cloud/cli/appctl.ts export counter counter.json
```

Import into an unused name and explicitly publish to resume:

```sh
node cloud/cli/appctl.ts import restored counter.json
node cloud/cli/appctl.ts publish restored examples/cloud-counter
```
