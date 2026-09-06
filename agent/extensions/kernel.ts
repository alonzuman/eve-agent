import kernel from "@onkernel/eve-extension";

// Connect binds Kernel consent and credentials to the authenticated sender.
export default kernel({ connect: "kernel/eve-kernel" });
