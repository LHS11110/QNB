import json
import unittest

from qnb import app as qnb_app
from qnb import category, runtime


class CategoryProverTests(unittest.TestCase):
    def test_naturality_and_functor_law_proof_succeeds(self):
        src = "\n".join([
            "category C, D",
            "object A, B, X : C",
            "morphism f : A -> B",
            "morphism g : B -> X",
            "functor F : C -> D",
            "functor G : C -> D",
            "nat alpha : F => G",
            "theorem naturality_comp : G(g ∘ f) ∘ alpha(A) = alpha(X) ∘ F(g) ∘ F(f) by",
            "  functor_comp",
            "  naturality alpha",
            "  assoc",
            "  naturality alpha",
            "  rfl",
        ])
        res = category.verify_and_visualize("/examples/naturality.cat", src)
        self.assertEqual(res["exitCode"], 0)
        viz = res["visualization"]
        self.assertTrue(viz["ok"])
        self.assertEqual(viz["kind"], "category")
        self.assertTrue(viz["theorems"][0]["verified"])
        self.assertGreaterEqual(len(viz["diagram"]["nodes"]), 3)
        self.assertGreaterEqual(len(viz["diagram"]["edges"]), 2)
        self.assertTrue(viz["diagram"]["stringWires"])
        solved_steps = [s for s in viz["steps"] if s["status"] == "solved"]
        self.assertEqual(len(solved_steps), 1)
        self.assertIsNotNone(solved_steps[0]["computation"])

    def test_adjunction_product_coproduct_and_iso(self):
        src = "\n".join([
            "category C, D",
            "object A : C",
            "object B : D",
            "adjunction F -| G : C <-> D",
            "theorem tri : eps(F(A)) ∘ F(eta(A)) ∘ id(F(A)) = id(F(A)) by",
            "  id_right",
            "  zig",
            "  rfl",
            "object X, P1, P2 : C",
            "product P of P1, P2",
            "morphism u : X -> P1",
            "morphism v : X -> P2",
            "morphism h : X -> P",
            "theorem beta : fst ∘ <u, v> = u by",
            "  product_beta",
            "  rfl",
            "theorem eta_rule : <fst ∘ h, snd ∘ h> = h by",
            "  product_eta",
            "  rfl",
            "iso iso_u : P1 <-> P2",
            "theorem cancel_u : inv(iso_u) ∘ iso_u = id(P1) by",
            "  iso_cancel",
            "  rfl",
        ])
        res = category.verify_and_visualize("/adj.cat", src)
        self.assertEqual(res["exitCode"], 0)
        self.assertEqual(len(res["visualization"]["theorems"]), 4)
        self.assertTrue(all(t["verified"] for t in res["visualization"]["theorems"]))

    def test_composition_domain_codomain_mismatch_fails(self):
        src = "\n".join([
            "category C",
            "object A, B, D : C",
            "morphism f : A -> B",
            "morphism g : D -> A",
            "theorem bad : g ∘ f = id(A) by",
            "  rfl",
        ])
        res = category.verify_and_visualize("/bad.cat", src)
        self.assertEqual(res["exitCode"], 1)
        self.assertFalse(res["visualization"]["ok"])
        self.assertIn("불일치", res["visualization"]["error"])

    def test_unclosed_theorem_fails(self):
        src = "\n".join([
            "category C",
            "object A : C",
            "theorem open_goal : id(A) = id(A) by",
            "  assoc",
        ])
        res = category.verify_and_visualize("/open.cat", src)
        self.assertEqual(res["exitCode"], 1)
        self.assertFalse(res["visualization"]["ok"])

    def test_steps_carry_commutative_path_diagrams(self):
        src = "\n".join([
            "category C, D",
            "object A, B, X : C",
            "morphism f : A -> B",
            "morphism g : B -> X",
            "functor F : C -> D",
            "functor G : C -> D",
            "nat alpha : F => G",
            "theorem naturality_comp : G(g ∘ f) ∘ alpha(A) = alpha(X) ∘ F(g) ∘ F(f) by",
            "  functor_comp",
            "  naturality alpha",
            "  assoc",
            "  naturality alpha",
            "  rfl",
        ])
        steps = category.verify_and_visualize("/n.cat", src)["visualization"]["steps"]
        labels = lambda arrows: [a["math"] for a in arrows]
        start = next(s for s in steps if s["tactic"] == "theorem")["diagram"]
        self.assertEqual((start["domMath"], start["codMath"]), ("F(A)", "G(X)"))
        self.assertEqual(labels(start["top"]), ["α_{A}", "G(g ∘ f)"])
        self.assertEqual(labels(start["bottom"]), ["F(f)", "F(g)", "α_{X}"])
        self.assertFalse(start["commutes"])
        # After the first naturality rewrite the shared F(f) is pasted and the rest is the naturality square of g.
        square = [s for s in steps if s["tactic"] == "naturality"][0]["diagram"]
        self.assertEqual(labels(square["prefix"]), ["F(f)"])
        self.assertEqual(labels(square["top"]), ["α_{B}", "G(g)"])
        self.assertEqual(labels(square["bottom"]), ["F(g)", "α_{X}"])
        self.assertEqual(square["top"][0]["kind"], "component")
        solved = steps[-1]["diagram"]
        self.assertTrue(solved["commutes"])
        self.assertEqual(labels(solved["top"]), ["α_{A}", "G(g ∘ f)"])

    def test_math_labels(self):
        self.assertEqual(category.math_morph(category.MorphInv(category.MorphVar("u"))), "u^{-1}")
        self.assertEqual(category.math_morph(category.MorphId(category.ObjName("A"))), "1_{A}")
        self.assertEqual(category.math_morph(category.MorphVar("fst")), "π_{1}")
        self.assertEqual(category.math_name("eps"), "ε")

    def test_notebook_cell_language_detection_for_category(self):
        doc = {"nbformat": 4, "metadata": {"kernelspec": {"name": "python3"}}, "cells": []}
        self.assertEqual(runtime.language(doc, {"cell_type": "code", "metadata": {}, "source": "%%category\ncategory C"}), "category")
        self.assertEqual(runtime.language(doc, {"cell_type": "code", "metadata": {"qnb_language": "category"}, "source": "category C"}), "category")
        self.assertEqual(runtime.code_cell_source({"source": "%%category\ncategory C"}, "category"), "category C")


if __name__ == "__main__":
    unittest.main()
