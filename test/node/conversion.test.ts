import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { MkvOutputFormat, MpegTsOutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { assert } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicPath = (file: string) => path.join(__dirname, '../public', file);

// demo.mp4 has an AAC audio track starting at -0.021333s (encoder priming) and an AVC video track
test('Default MP4 to MKV conversion copies audio with a negative start', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('demo.mp4')),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	expect(conversion.discardedTracks).toHaveLength(0);
	expect(conversion.utilizedTracks).toHaveLength(2);

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const inputAudioTrack = await input.getPrimaryAudioTrack();
	assert(inputAudioTrack);
	const outputAudioTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputAudioTrack);

	const inputSink = new EncodedPacketSink(inputAudioTrack);
	const outputSink = new EncodedPacketSink(outputAudioTrack);

	const inputPackets = [];
	for await (const packet of inputSink.packets()) {
		inputPackets.push(packet);
	}
	const outputPackets = [];
	for await (const packet of outputSink.packets()) {
		outputPackets.push(packet);
	}

	// All audio packets must have been copied over, byte for byte
	expect(outputPackets.length).toBe(236);
	expect(outputPackets.length).toBe(inputPackets.length);
	for (let i = 0; i < inputPackets.length; i++) {
		expect(outputPackets[i]!.data).toEqual(inputPackets[i]!.data);
	}

	// The negative start must be preserved (up to the millisecond timestamp tick)
	expect(inputPackets[0]!.timestamp).toBeCloseTo(-1024 / 48000, 10);
	expect(Math.abs(outputPackets[0]!.timestamp - inputPackets[0]!.timestamp)).toBeLessThanOrEqual(0.001);
});

test('MKV metadata duration matches the actual packet end', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('demo.mp4')),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const metadataDuration = await outputAsInput.getDurationFromMetadata();
	assert(metadataDuration !== null);
	const computedDuration = await outputAsInput.computeDuration();

	// The metadata duration must line up with the actual end of the media to within a millisecond tick
	expect(Math.abs(metadataDuration - computedDuration)).toBeLessThanOrEqual(0.001);

	for (const track of await outputAsInput.getTracks()) {
		const trackMetadataDuration = await track.getDurationFromMetadata();
		assert(trackMetadataDuration !== null);
		const trackComputedDuration = await track.computeDuration();

		expect(Math.abs(trackMetadataDuration - trackComputedDuration)).toBeLessThanOrEqual(0.001);
	}
});

test('Default MP4 to MPEG-TS conversion with timestampOffset keeps audio', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('demo.mp4')),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new MpegTsOutputFormat({ timestampOffset: 10 }),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	expect(conversion.discardedTracks).toHaveLength(0);
	expect(conversion.utilizedTracks).toHaveLength(2);
});

test('Copy ruled out by copy configuration is not reported as undecodable', async () => {
	using input = new Input({
		source: new FilePathSource(publicPath('demo.mp4')),
		formats: ALL_FORMATS,
	});
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	// The tight boundary tolerance rules out copying, and since this environment cannot decode the
	// tracks for transcoding either, they get discarded - but not with a reason that blames the codec
	const conversion = await Conversion.init({
		input,
		output,
		trim: { start: 1.5 },
		copy: { boundaryTolerance: 0.001 },
		showWarnings: false,
	});

	expect(conversion.discardedTracks.length).toBeGreaterThan(0);
	for (const discardedTrack of conversion.discardedTracks) {
		expect(discardedTrack.reason).toBe('cannot_copy');
	}
});
