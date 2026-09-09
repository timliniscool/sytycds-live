declare module "cloudflare:workers" {
  // Required module augmentation shape for the Cloudflare Vitest environment.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}
