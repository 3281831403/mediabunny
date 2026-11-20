import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	MkvOutputFormat,
	Mp4OutputFormat,
	Output,
} from '../../src/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name: string) => path.join(__dirname, '..', 'public', name);

// The fixtures for this test file are regular MP4 files whose elst box has been patched to cover the various
// edit list scenarios:
// - bframes.mp4: single edit (3000, 2048), shifting the media 0.2s to the left
// - trim-start.mp4: single edit (2000, 12288), trimming the first 1.2s of media
// - delay.mp4: empty edit (500, -1) followed by (3000, 2048), delaying the media by 0.5s
// - trim-end-elst.mp4: empty edit (500, -1) followed by (1300, 2048), trimming the media tail
// - multi-edit.mp4: two edits (1000, 2048) and (1000, 13312), playing two separate media ranges
// - empty-elst.mp4: an elst box with zero entries, equivalent to having no edit list
// - av-trim-video.mp4: video edit (1000, 2048) and audio edit (3000, 1024), trimming only the video

type PacketInfo = {
	sequenceNumber: number;
	timestamp: number;
	duration: number;
};

const getPackets = async (filePath: string, trackIndex = 0) => {
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = (await input.getTracks())[trackIndex]!;
	const sink = new EncodedPacketSink(track);
	const packets: PacketInfo[] = [];
	for await (const packet of sink.packets()) {
		packets.push({
			sequenceNumber: packet.sequenceNumber,
			timestamp: packet.timestamp,
			duration: packet.duration,
		});
	}

	return {
		sink,
		packets,
		firstTimestamp: await track.getFirstTimestamp(),
		duration: await track.computeDuration(),
		metadataDuration: await track.getDurationFromMetadata({ skipLiveWait: true }),
	};
};

const rewrap = async (filePath: string, format: 'mp4' | 'mkv') => {
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format: format === 'mkv' ? new MkvOutputFormat() : new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const jobs: { track: import('../../src/index.js').InputTrack; source: unknown }[] = [];
	for (const track of await input.getTracks()) {
		const codec = await track.getCodec();
		if (!codec) {
			continue;
		}

		if (track.type === 'video') {
			const source = new EncodedVideoPacketSource(codec);
			output.addVideoTrack(source);
			jobs.push({ track, source });
		} else if (track.type === 'audio') {
			const source = new EncodedAudioPacketSource(codec);
			output.addAudioTrack(source);
			jobs.push({ track, source });
		}
	}

	await output.start();
	await Promise.all(jobs.map(async ({ track, source }) => {
		const decoderConfig = await track.getDecoderConfig();
		for await (const packet of new EncodedPacketSink(track).packets()) {
			await (source as EncodedVideoPacketSource).add(packet, { decoderConfig: decoderConfig ?? undefined });
		}
	}));
	await output.finalize();

	return (output.target as BufferTarget).buffer!;
};

const readPacketsFromBuffer = async (buffer: ArrayBuffer, trackIndex = 0) => {
	using input = new Input({
		source: new BufferSource(buffer),
		formats: ALL_FORMATS,
	});

	const track = (await input.getTracks())[trackIndex]!;
	const sink = new EncodedPacketSink(track);
	const packets: PacketInfo[] = [];
	for await (const packet of sink.packets()) {
		packets.push({
			sequenceNumber: packet.sequenceNumber,
			timestamp: packet.timestamp,
			duration: packet.duration,
		});
	}

	return { packets, duration: await track.computeDuration() };
};

test('Trailing trim affects duration, metadata and seek boundary', async () => {
	using input = new Input({
		source: new FilePathSource(fixture('trim-end-elst.mp4')),
		formats: ALL_FORMATS,
	});

	expect(await input.computeDuration()).toBe(1.8);

	const track = (await input.getTracks())[0]!;
	const sink = new EncodedPacketSink(track);

	expect(await track.computeDuration()).toBe(1.8);
	expect(await track.getDurationFromMetadata({ skipLiveWait: true })).toBe(1.8);

	// The last presented packet sits right before the 1.8s end of the edit
	const hit = await sink.getPacket(1.7);
	expect(hit).not.toBeNull();
	expect(hit!.timestamp).toBe(1.7);

	// Past the end of the edit, there is no packet anymore
	expect(await sink.getPacket(1.85)).toBeNull();
});

test('Multiple edits map onto a contiguous presentation timeline', async () => {
	using input = new Input({
		source: new FilePathSource(fixture('multi-edit.mp4')),
		formats: ALL_FORMATS,
	});

	const track = (await input.getTracks())[0]!;
	const sink = new EncodedPacketSink(track);

	expect(await track.computeDuration()).toBe(2);

	// The two 1s edits play back to back; the media in between is skipped
	const p1 = await sink.getPacket(1.0);
	expect(p1).not.toBeNull();
	expect(p1!.sequenceNumber).toBe(12);

	const p15 = await sink.getPacket(1.5);
	expect(p15).not.toBeNull();
	expect(p15!.sequenceNumber).toBe(15);

	// The sample in the gap between the two edits is not presented
	const packets: number[] = [];
	for await (const packet of sink.packets()) {
		packets.push(packet.timestamp);
	}
	expect(packets.length).toBe(20);
	expect(packets.every(t => t >= 0 && t < 2)).toBe(true);
});

test('Empty edit list is equivalent to no edit list', async () => {
	const empty = await getPackets(fixture('empty-elst.mp4'));
	const none = await getPackets(fixture('bframes.mp4'));

	expect(empty.packets.length).toBe(none.packets.length);
	expect(empty.duration).toBe(3.2);
	expect(empty.firstTimestamp).toBe(0.2);

	// bframes.mp4 has an edit list that shifts the media 0.2s to the left; the empty-elst variant must produce
	// the same packets as the raw media, i.e. shifted by 0.2s relative to bframes.mp4
	for (let i = 0; i < empty.packets.length; i++) {
		expect(empty.packets[i]!.timestamp).toBeCloseTo(none.packets[i]!.timestamp + 0.2, 10);
	}
});

test('Edit lists are applied per track', async () => {
	using input = new Input({
		source: new FilePathSource(fixture('av-trim-video.mp4')),
		formats: ALL_FORMATS,
	});

	// The video track is trimmed to 1s while the audio track plays for 3s
	expect(await input.computeDuration()).toBe(3);

	const video = await getPackets(fixture('av-trim-video.mp4'), 0);
	const audio = await getPackets(fixture('av-trim-video.mp4'), 1);
	expect(video.duration).toBe(1);
	expect(audio.duration).toBe(3);
});

test('Leading trim produces negative preroll timestamps', async () => {
	const { packets, duration } = await getPackets(fixture('trim-start.mp4'));

	// The samples before the edit's media time are kept as negatively-stamped preroll
	expect(packets[0]!.timestamp).toBeLessThan(0);
	expect(duration).toBe(2);
});

test('Empty edit delays the media', async () => {
	const { packets, duration } = await getPackets(fixture('delay.mp4'));

	expect(duration).toBe(3.5);
	expect(packets[0]!.timestamp).toBe(0.5);
});

const REWRAP_FIXTURES = ['bframes.mp4', 'trim-start.mp4', 'delay.mp4', 'trim-end-elst.mp4', 'av-trim-video.mp4'];

for (const format of ['mp4', 'mkv'] as const) {
	test(`Rewrapping to ${format.toUpperCase()} preserves the presented timeline`, async () => {
		for (const name of REWRAP_FIXTURES) {
			const src = await getPackets(fixture(name));
			const buffer = await rewrap(fixture(name), format);
			const out = await readPacketsFromBuffer(buffer);

			expect(out.duration, name).toBeCloseTo(src.duration, format === 'mkv' ? 2 : 6);

			const presented = src.packets.filter(p => p.timestamp < src.duration);
			expect(out.packets.length, name).toBe(presented.length);
			for (let i = 0; i < presented.length; i++) {
				expect(out.packets[i]!.timestamp, `${name} packet ${i}`).toBeCloseTo(
					presented[i]!.timestamp,
					format === 'mkv' ? 2 : 6,
				);
			}
		}
	});
}

test('Shipped files with edit lists are unaffected', async () => {
	for (const [name, first, duration] of [
		['edts.mp4', 0, 9],
		['video.mp4', 0, 5],
		['demo.mp4', 0, 5],
	] as const) {
		const result = await getPackets(fixture(name));
		expect(result.firstTimestamp, name).toBe(first);
		expect(result.duration, name).toBe(duration);
	}
});
