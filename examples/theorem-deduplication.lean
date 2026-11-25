universe u v

-- QNB stores this as the representative theorem.
theorem qnbRefl {α : Type u} (x : α) : x = x := rfl

-- The notation and binder names differ, but the elaborated proposition is the same.
theorem qnbReflAlias {β : Type v} (y : β) : Eq y y := rfl

-- This proposition is distinct. Its reference to qnbReflAlias points to qnbRefl in the graph.
theorem qnbReflAndTrue (n : Nat) : n = n ∧ True :=
  ⟨qnbReflAlias n, True.intro⟩
