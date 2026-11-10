# vCaravan

## Deploying

The app is served as static files from `C:\Files\Sync\Public\Apps\vCaravan`.
To deploy:

1. Build, from the repository root:

   ```bash
   pnpm build
   ```

   This runs `vite build` for `apps/web` and writes the site to `apps/web/dist`.

2. Delete everything in `C:\Files\Sync\Public\Apps\vCaravan`. Built files have
   hashed names, so old ones would otherwise pile up next to the new ones.

3. Copy everything in `apps/web/dist` into `C:\Files\Sync\Public\Apps\vCaravan`.

A phone may keep showing the old version until the page is reloaded.
