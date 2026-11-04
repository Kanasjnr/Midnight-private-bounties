// @vitest-environment node
//
// Chat without the relays: both ends reach the same channel from their own
// keys, an application code carries the applicant's contact key to the
// poster, messages round-trip and fail closed for anyone else, and edits only
// count from the author.
import { describe, expect, it } from "vitest";
import { verifyEvent } from "nostr-tools/pure";
import { posterKeyFor } from "../../../contract/keys.js";
import { randomScalar } from "../../../contract/witnesses.js";
import { newPrivateState } from "@/midnight/private-bounties-api";
import { applicationEvent, contactKey, conversation, inboxTag, openChannel, openMessage, publicKeyOf, sealMessage, type Sealed } from "~/midnight/chat";

const ADDRESS = "ab".repeat(32);
const ID = new Uint8Array(32).fill(7);

async function ends() {
  const poster = newPrivateState();
  const applicant = newPrivateState();
  const b = await posterKeyFor(poster.posterSeed!, ADDRESS, ID);
  const c = await contactKey(applicant.sk, ADDRESS, ID);
  const posterSide = await openChannel(b, publicKeyOf(c), ID);
  const applicantSide = await openChannel(c, publicKeyOf(b), ID);
  return { b, c, posterSide, applicantSide, applicant };
}

describe("chat", () => {
  it("gives both ends the same thread and key, and each its own signer", async () => {
    const { posterSide, applicantSide, applicant, c } = await ends();
    expect(posterSide.thread).toEqual(applicantSide.thread);
    expect(posterSide.me).not.toEqual(applicantSide.me);
    // The contact key is the same every time, so it needs no storage.
    expect(await contactKey(applicant.sk, ADDRESS, ID)).toEqual(c);
    expect(await contactKey(applicant.sk, ADDRESS, new Uint8Array(32).fill(8))).not.toEqual(c);
  });

  it("round-trips a message, and nobody else can open it", async () => {
    const { posterSide, applicantSide } = await ends();
    const ev = await sealMessage(applicantSide, "  Hi, can I start Monday?  ");
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.tags).toEqual([["z", posterSide.thread]]);
    expect(ev.content).not.toContain("Monday");
    expect((await openMessage(posterSide, ev))?.body.text).toEqual("Hi, can I start Monday?");
    const stranger = await openChannel(randomScalar(), publicKeyOf(randomScalar()), ID);
    expect(await openMessage(stranger, ev)).toBeNull();
    await expect(sealMessage(applicantSide, "   ")).rejects.toThrow("Write something first");
  });

  it("applies edits only from the author, and links replies", async () => {
    const { posterSide, applicantSide } = await ends();
    const open = async (ev: Awaited<ReturnType<typeof sealMessage>>) => (await openMessage(posterSide, ev)) as Sealed;
    const first = await open(await sealMessage(applicantSide, "Start Monday?"));
    const answer = await open(await sealMessage(posterSide, "Yes", { re: first.id }));
    const edit = await open(await sealMessage(applicantSide, "Start Tuesday?", { edit: first.id }));
    // The poster tries to rewrite the applicant's message: ignored.
    const forged = await open(await sealMessage(posterSide, "I'll do it for free", { edit: first.id }));
    const view = conversation([answer, forged, first, edit], posterSide.me);
    expect(view.map((m) => [m.text, m.mine, m.edited])).toEqual([
      ["Start Tuesday?", false, true],
      ["Yes", true, false],
    ]);
    expect(view[1]!.replyTo).toEqual({ id: first.id, text: "Start Tuesday?", mine: false });
  });

  it("sends applications to a public inbox tag, signed by a throwaway key", async () => {
    const tag = await inboxTag(ADDRESS, ID);
    expect(tag).toEqual(await inboxTag(ADDRESS.toUpperCase(), ID));
    const a = applicationEvent(tag, "pbapp1.x.y.z", crypto.getRandomValues(new Uint8Array(32)));
    const b = applicationEvent(tag, "pbapp1.x.y.z", crypto.getRandomValues(new Uint8Array(32)));
    expect(a.pubkey).not.toEqual(b.pubkey);
    expect(verifyEvent(a)).toBe(true);
    expect(a.tags).toEqual([["z", tag]]);
  });
});
