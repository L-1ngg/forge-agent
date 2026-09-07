import { spawn } from "node:child_process";
import { release } from "node:os";

/** Native delivery has an exit status; OSC 52 remains an unacknowledged fallback. */
export async function copyNative(text: string): Promise<boolean> {
	const windows = process.platform === "win32" || /microsoft/i.test(release()) || !!process.env.WSL_DISTRO_NAME;
	const command = windows ? "clip.exe" : process.platform === "darwin" ? "pbcopy" : process.env.WAYLAND_DISPLAY ? "wl-copy" : process.env.DISPLAY ? "xclip" : undefined;
	if (!command) return false;
	return new Promise((resolve) => {
		const child = spawn(command, command === "xclip" ? ["-selection", "clipboard"] : [], { stdio: ["pipe", "ignore", "ignore"] });
		const timeout = setTimeout(() => { child.kill(); resolve(false); }, 1500);
		const finish = (ok: boolean) => { clearTimeout(timeout); resolve(ok); };
		child.on("error", () => finish(false));
		child.on("close", (code) => finish(code === 0));
		child.stdin.on("error", () => finish(false));
		child.stdin.end(Buffer.from(text, windows ? "utf16le" : "utf8"));
	});
}
