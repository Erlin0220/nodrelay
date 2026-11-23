using Workerd = import "/workerd/workerd.capnp";

const tests :Workerd.Config = (
  services = [
    (name = "upgrade", worker = (
      compatibilityDate = "2026-07-30",
      globalOutbound = "fixture",
      modules = [
        (name = "test.mjs", esModule = embed "upgrade.mjs"),
        (name = "signed-fixture.mjs", esModule = embed "signed-fixture.mjs"),
        (name = "upgrade-artifacts.mjs", esModule = embed "../../cloud/upgrade-artifacts.mjs"),
        (name = "upgrade-plan.mjs", esModule = embed "../../cloud/upgrade-plan.mjs"),
        (name = "upgrade-feed-migration.mjs", esModule = embed "../../cloud/upgrade-feed-migration.mjs"),
        (name = "upgrade-enrollment-release.mjs", esModule = embed "../../cloud/upgrade-enrollment-release.mjs"),
        (name = "device-paths.mjs", esModule = embed "../../cloud/device-paths.mjs"),
        (name = "enrollment-bootstrap.mjs", esModule = embed "../../cloud/enrollment-bootstrap.mjs"),
      ],
    )),
    (name = "fixture", worker = (
      compatibilityDate = "2026-07-30",
      globalOutbound = "fixture",
      modules = [
        (name = "feed.mjs", esModule = embed "feed.mjs"),
        (name = "signed-fixture.mjs", esModule = embed "signed-fixture.mjs"),
      ],
    )),
  ],
);
