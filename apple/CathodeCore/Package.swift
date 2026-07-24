// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CathodeCore",
    platforms: [.macOS(.v13), .iOS(.v17), .tvOS(.v17)],
    products: [
        .library(name: "CathodeCore", targets: ["CathodeCore"]),
    ],
    targets: [
        .target(name: "CathodeCore"),
        .testTarget(name: "CathodeCoreTests", dependencies: ["CathodeCore"]),
    ]
)
