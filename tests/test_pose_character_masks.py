import base64
import importlib.util
import io
import sys
import types
import unittest
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]


def _load_pose_studio_module():
    fake_torch = types.ModuleType("torch")
    fake_torch.Tensor = object
    previous_torch = sys.modules.get("torch")
    package = types.ModuleType("vnccs_pose_mask_testpkg")
    package.__path__ = [str(ROOT)]
    nodes_package = types.ModuleType("vnccs_pose_mask_testpkg.nodes")
    nodes_package.__path__ = [str(ROOT / "nodes")]
    sys.modules["torch"] = fake_torch
    sys.modules[package.__name__] = package
    sys.modules[nodes_package.__name__] = nodes_package
    try:
        name = "vnccs_pose_mask_testpkg.nodes.pose_studio"
        spec = importlib.util.spec_from_file_location(name, ROOT / "nodes" / "pose_studio.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        if previous_torch is None:
            sys.modules.pop("torch", None)
        else:
            sys.modules["torch"] = previous_torch


POSE_STUDIO = _load_pose_studio_module()
W, H = 8, 4


def _png(array):
    buffer = io.BytesIO()
    Image.fromarray(array.astype(np.uint8), "RGB").save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _character_regions():
    """Four characters: column pairs 0-1, 2-3, 4-5, 6-7, with a soft edge on character 1."""
    masks = np.zeros((4, H, W), dtype=np.float32)
    for index in range(4):
        masks[index, :, index * 2:index * 2 + 2] = 1.0
    masks[0, 0, 2] = 0.5
    masks[1, 0, 2] = 0.5  # an overlap pixel split between characters 1 and 2
    return masks


def _packs(masks):
    packs = []
    for start in range(0, len(masks), 3):
        rgb = np.zeros((H, W, 3), dtype=np.float32)
        for channel in range(3):
            if start + channel < len(masks):
                rgb[:, :, channel] = masks[start + channel]
        packs.append(_png(np.round(rgb * 255)))
    return packs


class CharacterMaskDecodeTests(unittest.TestCase):
    def test_packs_decode_to_one_mask_per_character_in_slot_order(self):
        masks = _character_regions()
        entry = {"characters": [{"slot": i} for i in range(4)], "packs": _packs(masks)}
        decoded = POSE_STUDIO._decode_character_mask_entry(entry, 4, W, H)
        self.assertEqual(decoded.shape, (4, H, W))
        self.assertEqual(decoded.dtype, np.float32)
        np.testing.assert_allclose(decoded, masks, atol=1 / 255)

    def test_three_characters_fit_one_pack(self):
        masks = _character_regions()[:3]
        decoded = POSE_STUDIO._decode_character_mask_entry({"packs": _packs(masks)}, 3, W, H)
        np.testing.assert_allclose(decoded, masks, atol=1 / 255)

    def test_wrong_pack_count_or_size_is_rejected(self):
        masks = _character_regions()
        self.assertIsNone(POSE_STUDIO._decode_character_mask_entry({"packs": _packs(masks)[:1]}, 4, W, H))
        self.assertIsNone(POSE_STUDIO._decode_character_mask_entry({"packs": _packs(masks)}, 4, W + 1, H))
        self.assertIsNone(POSE_STUDIO._decode_character_mask_entry(None, 4, W, H))

    def test_missing_entries_fall_back_to_empty_masks_per_pose(self):
        masks = _character_regions()[:2]
        data = {
            "characters": [{"id": "a"}, {"id": "b"}],
            "character_masks": [{"packs": _packs(masks)}, None],
        }
        arrays = POSE_STUDIO._character_mask_arrays(data, [(W, H), (W, H), (W, H)])
        self.assertEqual(len(arrays), 3)
        np.testing.assert_allclose(arrays[0], masks, atol=1 / 255)
        for empty in arrays[1:]:
            self.assertEqual(empty.shape, (2, H, W))
            self.assertEqual(float(empty.max()), 0.0)

    def test_legacy_scene_without_characters_has_one_mask(self):
        arrays = POSE_STUDIO._character_mask_arrays({}, [(W, H)])
        self.assertEqual(arrays[0].shape, (1, H, W))

    def test_grid_matches_image_grid_layout(self):
        first = np.zeros((2, H, W), dtype=np.float32)
        second = np.ones((2, H, W), dtype=np.float32)
        third = np.full((2, H, W), 0.5, dtype=np.float32)
        grid = POSE_STUDIO._grid_character_masks([first, second, third], 2)
        self.assertEqual(grid.shape, (2, H * 2, W * 2))
        self.assertEqual(float(grid[:, :H, :W].max()), 0.0)
        self.assertEqual(float(grid[:, :H, W:].min()), 1.0)
        self.assertEqual(float(grid[:, H:, :W].mean()), 0.5)
        self.assertEqual(float(grid[:, H:, W:].max()), 0.0)


class CharacterMaskNodeTests(unittest.TestCase):
    def test_pose_studio_declares_character_masks_output(self):
        node = POSE_STUDIO.VNCCS_PoseStudio
        self.assertEqual(node.RETURN_NAMES, ("images", "lighting_prompt", "character_masks"))
        self.assertEqual(node.RETURN_TYPES[2], "MASK")
        self.assertEqual(len(node.OUTPUT_IS_LIST), 3)
        self.assertEqual(len(node.OUTPUT_TOOLTIPS), 3)

    def test_select_character_mask_is_one_based_and_tolerates_missing(self):
        masks = _character_regions()
        node = POSE_STUDIO.VNCCS_PoseCharacterMask()
        (second,) = node.select(masks, 2)
        self.assertEqual(second.shape, (1, H, W))
        np.testing.assert_array_equal(second[0], masks[1])
        (missing,) = node.select(masks[:2], 4)
        self.assertEqual(missing.shape, (1, H, W))
        self.assertEqual(float(missing.max()), 0.0)
        (single,) = node.select(masks[0], 1)
        self.assertEqual(single.shape, (1, H, W))

    def test_helper_node_is_registered(self):
        self.assertIn("VNCCS_PoseCharacterMask", POSE_STUDIO.NODE_CLASS_MAPPINGS)
        inputs = POSE_STUDIO.VNCCS_PoseCharacterMask.INPUT_TYPES()["required"]
        self.assertEqual(inputs["character"][1]["max"], 4)


if __name__ == "__main__":
    unittest.main()
