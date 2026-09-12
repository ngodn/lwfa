import XCTest
@testable import LWFACore

final class AudioJitterBufferTests: XCTestCase {
    private func packet(_ frames: Int, value: Float) -> [Float] { [Float](repeating: value, count: frames * 2) }
    private func render(_ buffer: AudioJitterBuffer, frames: Int) -> (served: Int, samples: [Float]) {
        var out = [Float](repeating: -1, count: frames * 2)
        let served = out.withUnsafeMutableBufferPointer { buffer.read(into: $0.baseAddress!, frames: frames) }
        return (served, out)
    }

    func testSilentUntilPrimed() {
        let buffer = AudioJitterBuffer(cushionFrames: 2_880, ceilingFrames: 7_200)
        XCTAssertTrue(buffer.write(packet(960, value: 0.5)))
        XCTAssertTrue(buffer.write(packet(960, value: 0.5)))
        let first = render(buffer, frames: 256)
        XCTAssertEqual(first.served, 0)
        XCTAssertTrue(first.samples.allSatisfy { $0 == 0 })
        XCTAssertEqual(buffer.queuedFrames, 1_920, "Priming must not consume queued audio")
        XCTAssertTrue(buffer.write(packet(960, value: 0.5)))
        let second = render(buffer, frames: 256)
        XCTAssertEqual(second.served, 256)
        XCTAssertTrue(second.samples.allSatisfy { $0 == 0.5 })
        XCTAssertEqual(buffer.queuedFrames, 2_880 - 256)
        XCTAssertTrue(buffer.statistics.primed)
        XCTAssertEqual(buffer.statistics.underruns, 0)
    }

    func testUnderrunZeroFillsAndReprimes() {
        let buffer = AudioJitterBuffer(cushionFrames: 480, ceilingFrames: 4_800)
        XCTAssertTrue(buffer.write(packet(480, value: 1)))
        let drained = render(buffer, frames: 600)
        XCTAssertEqual(drained.served, 480)
        XCTAssertTrue(drained.samples[..<960].allSatisfy { $0 == 1 })
        XCTAssertTrue(drained.samples[960...].allSatisfy { $0 == 0 })
        XCTAssertEqual(buffer.statistics.underruns, 1)
        XCTAssertFalse(buffer.statistics.primed)
        XCTAssertTrue(buffer.write(packet(100, value: 1)))
        XCTAssertEqual(render(buffer, frames: 50).served, 0, "Below the cushion after an underrun stays silent")
        XCTAssertTrue(buffer.write(packet(400, value: 1)))
        XCTAssertEqual(render(buffer, frames: 50).served, 50)
    }

    func testOverflowSkipsAheadToCushion() {
        let buffer = AudioJitterBuffer(cushionFrames: 960, ceilingFrames: 2_400)
        for index in 0..<3 { XCTAssertTrue(buffer.write(packet(960, value: Float(index)))) }
        // 2,880 queued exceeds the 2,400 ceiling: the consumer must skip ahead.
        XCTAssertEqual(buffer.statistics.overflows, 1)
        let out = render(buffer, frames: 960)
        XCTAssertEqual(out.served, 960)
        XCTAssertTrue(out.samples.allSatisfy { $0 == 2 }, "Oldest audio is skipped; the newest packet plays")
        XCTAssertEqual(buffer.queuedFrames, 0)
    }

    func testResetDiscardsQueueAndReprimes() {
        let buffer = AudioJitterBuffer(cushionFrames: 480, ceilingFrames: 4_800)
        XCTAssertTrue(buffer.write(packet(960, value: 1)))
        XCTAssertEqual(render(buffer, frames: 100).served, 100)
        buffer.reset()
        let out = render(buffer, frames: 100)
        XCTAssertEqual(out.served, 0)
        XCTAssertEqual(buffer.queuedFrames, 0)
        XCTAssertFalse(buffer.statistics.primed)
        XCTAssertTrue(buffer.write(packet(480, value: 2)))
        XCTAssertTrue(render(buffer, frames: 10).samples.allSatisfy { $0 == 2 })
    }

    func testWrapAroundPreservesOrder() {
        let buffer = AudioJitterBuffer(capacityFrames: 1_024, cushionFrames: 0, ceilingFrames: 1_000)
        var next: Float = 0
        var expected: Float = 0
        for _ in 0..<40 {
            var samples: [Float] = []
            for _ in 0..<100 { samples.append(next); samples.append(next); next += 1 }
            XCTAssertTrue(buffer.write(samples))
            let out = render(buffer, frames: 100)
            XCTAssertEqual(out.served, 100)
            for frame in 0..<100 {
                XCTAssertEqual(out.samples[frame * 2], expected)
                XCTAssertEqual(out.samples[frame * 2 + 1], expected)
                expected += 1
            }
        }
    }

    func testResetKeepsAudioWrittenBeforePlaybackRestarts() {
        let buffer = AudioJitterBuffer(cushionFrames: 480, ceilingFrames: 4_800)
        XCTAssertTrue(buffer.write(packet(960, value: 1)))
        buffer.reset()
        // The audio engine is stopped while reset runs. New decoded packets
        // arrive before its next render callback.
        XCTAssertTrue(buffer.write(packet(480, value: 2)))
        let out = render(buffer, frames: 480)
        XCTAssertEqual(out.served, 480)
        XCTAssertTrue(out.samples.allSatisfy { $0 == 2 })
    }

    func testResetStillReprimesIfOverflowFollowsBeforeNextRender() {
        let buffer = AudioJitterBuffer(cushionFrames: 480, ceilingFrames: 1_000)
        XCTAssertTrue(buffer.write(packet(480, value: 1)))
        XCTAssertEqual(render(buffer, frames: 100).served, 100)
        buffer.reset()
        XCTAssertTrue(buffer.write(packet(480, value: 2)))
        XCTAssertTrue(buffer.write(packet(480, value: 3)))
        let out = render(buffer, frames: 480)
        XCTAssertEqual(out.served, 480)
        XCTAssertTrue(out.samples.allSatisfy { $0 == 3 })
    }

    func testRejectsEmptyAndOversizedWrites() {
        let buffer = AudioJitterBuffer(capacityFrames: 1_024, cushionFrames: 0, ceilingFrames: 1_000)
        XCTAssertFalse(buffer.write([]))
        XCTAssertFalse(buffer.write(packet(600, value: 1)), "A packet larger than half the ring is refused")
        XCTAssertEqual(buffer.queuedFrames, 0)
    }
}
