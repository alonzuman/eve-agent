import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

// eve keys this sandbox by durable session. Server credentials are never seeded.
export default defineSandbox({ backend: vercel() });
