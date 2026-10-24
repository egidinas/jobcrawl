"""Model split: the dequantisation helper (numpy only). The split itself needs onnx and the model files; it is not run here."""
import unittest

from synthetic import HAVE_NUMPY, NUMPY_REASON


@unittest.skipUnless(HAVE_NUMPY, NUMPY_REASON)
class Dequant(unittest.TestCase):
    def test_nibbles_and_zero_points(self):
        import numpy as np
        from jobcrawl.model.split import dequant
        q = np.full((2, 256), 0x21, np.uint8)               # low nibble 1, high nibble 2, alternating
        zp = np.zeros((2, 8), np.uint8)                       # zero points 0
        scales = np.ones((2, 16), np.float16)
        out = dequant(q, scales, zp, np.array([1]))
        self.assertEqual(out.shape, (1, 512))
        self.assertEqual(float(out[0, 0]), 1.0)
        self.assertEqual(float(out[0, 1]), 2.0)

    def test_zero_point_and_scale_apply_per_block(self):
        import numpy as np
        from jobcrawl.model.split import dequant
        q = np.full((1, 256), 0x55, np.uint8)                 # both nibbles 5
        zp = np.zeros((1, 8), np.uint8)
        zp[0, 0] = 0x10                                       # byte 0 holds two zero points: block 0 = 0 (low nibble), block 1 = 1 (high nibble)
        zp[0, 0] |= 0x01                                      # block 0 = 1
        scales = np.ones((1, 16), np.float16)
        scales[0, 1] = np.float16(2.0)                        # block 1 scaled by 2
        out = dequant(q, scales, zp, np.array([0]))
        self.assertEqual(float(out[0, 0]), 4.0)               # block 0: (5 - 1) * 1
        self.assertEqual(float(out[0, 32]), 8.0)              # block 1: (5 - 1) * 2


class ModuleImports(unittest.TestCase):
    def test_split_imports_without_onnx(self):
        import jobcrawl.model.split as split
        self.assertTrue(callable(split.split))
        self.assertIn('check', split.split.__code__.co_varnames)


if __name__ == '__main__':
    unittest.main()
