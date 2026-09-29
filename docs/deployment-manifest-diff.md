# Deployment Manifest Diff

Use the manifest comparison utility to review deployment changes between two branches before merging:

~~~
npm run deployment:manifest:diff -- --base path/to/main-manifest.json --head path/to/dev-manifest.json
~~~

The report flattens nested manifest values into stable, sorted paths and labels each difference as ADDED, REMOVED, or CHANGED. It returns success when the comparison is complete, including when differences are found, so it can be used as a review report without blocking deployments.
