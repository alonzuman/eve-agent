import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";

export default defineMemory({
  description: "Remember useful stable facts and preferences about this caller only.",
  provider: fileMemory(),
  scope: byPrincipal,
});
