import importlib.util
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("stage_chart", pathlib.Path(__file__).with_name("stage-chart.py"))
stage_chart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage_chart)


class StageChartTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.source = self.root / "artifact"
        self.source.mkdir()
        self.destination = self.root / "publish"
        self.destination.mkdir()
        for name in ("star-history-light.svg", "star-history-dark.svg"):
            (self.source / name).write_bytes(b"<svg></svg>")
        (self.source / "star-history.png").write_bytes(b"\x89PNG\r\n\x1a\nfixture")
        (self.source / ".star-history.sig").write_text("a" * 64)

    def test_copies_only_fixed_data_files(self):
        stage_chart.stage(self.source, self.destination)
        self.assertEqual(sorted(p.name for p in self.destination.iterdir()), [".star-history.sig", "star-history-dark.svg", "star-history-light.svg", "star-history.png"])
        self.assertEqual((self.destination / "star-history-light.svg").read_bytes(), b"<svg></svg>")

    def test_rejects_symlink_instead_of_reading_its_target(self):
        path = self.source / "star-history-light.svg"
        path.unlink()
        path.symlink_to(self.root / "sensitive")
        with self.assertRaises((OSError, ValueError)):
            stage_chart.stage(self.source, self.destination)

    def test_rejects_extra_git_configuration(self):
        (self.source / ".gitconfig").write_text("[core]\n hooksPath = attacker\n")
        with self.assertRaisesRegex(ValueError, "files"):
            stage_chart.stage(self.source, self.destination)

    def test_rejects_oversized_and_malformed_payloads(self):
        with (self.source / "star-history.png").open("wb") as f:
            f.truncate(10 * 1024 * 1024 + 1)
        with self.assertRaises(ValueError):
            stage_chart.stage(self.source, self.destination)
        (self.source / "star-history.png").write_bytes(b"not a PNG")
        with self.assertRaises(ValueError):
            stage_chart.stage(self.source, self.destination)


if __name__ == "__main__":
    unittest.main()
