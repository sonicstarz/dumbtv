// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "dumbTVCore",
    platforms: [.macOS(.v13), .iOS(.v16), .tvOS(.v17)],
    products: [
        .library(name: "dumbTVCore", targets: ["dumbTVCore"]),
    ],
    targets: [
        .target(name: "dumbTVCore"),
        .testTarget(name: "dumbTVCoreTests", dependencies: ["dumbTVCore"]),
    ]
)
