// swift-tools-version: 6.3
import PackageDescription

let package = Package(
    name: "LWFA",
    platforms: [.iOS(.v26)],
    products: [
        .library(name: "LWFACore", targets: ["LWFACore"]),
        .library(name: "LWFA", targets: ["LWFA"]),
    ],
    targets: [
        .target(name: "COpus", exclude: ["COPYING", "AUTHORS", "UPSTREAM.md"], publicHeadersPath: "include", cSettings: [
            .define("OPUS_BUILD"), .define("VAR_ARRAYS"), .define("HAVE_LRINTF"), .define("HAVE_LRINT"),
            .headerSearchPath("celt"), .headerSearchPath("silk"), .headerSearchPath("silk/float"), .headerSearchPath("src"),
        ], linkerSettings: [.linkedLibrary("m")]),
        .target(name: "LWFACore", dependencies: ["COpus"]),
        .target(name: "LWFA", dependencies: ["LWFACore"], path: "NativeApp", resources: [.copy("Resources/layout.js"), .copy("Resources/mark-on-dark.png"), .copy("Resources/mark-on-light.png"), .copy("Resources/Opus-LICENSE.txt")]),
        .testTarget(name: "LWFACoreTests", dependencies: ["LWFACore", "COpus"]),
    ]
)
