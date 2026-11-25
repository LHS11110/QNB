import Lean

open Lean

-- The serialized kernel type retains universe parameters and implicit binders.
-- Expression metadata is irrelevant to kernel type checking.
local instance : ToJson LMVarId := ⟨fun _ => Json.null⟩
local instance : FromJson LMVarId := ⟨fun _ => .error "Unexpected universe metavariable"⟩
local instance : ToJson KVMap := ⟨fun _ => Json.null⟩
local instance : FromJson KVMap := ⟨fun _ => .ok {}⟩
deriving instance ToJson, FromJson for FVarId, MVarId, Level, Literal, BinderInfo, Expr

structure SavedStatement where
  name : Name
  type : Expr
  levelParams : List Name
  line : Nat
  needsContext : Bool
  deriving FromJson, ToJson

def addTrustedTheorem (env : Environment) (value : AxiomVal) (trusted : IO.Ref NameSet) : IO Environment := do
  match env.addDecl {} (.axiomDecl value) with
  | .ok next =>
    trusted.modify (·.insert value.name)
    return next
  | .error _ => throw (IO.userError s!"Kernel rejected saved statement {value.name}")

def restoreStatement (value : SavedStatement) (trusted : IO.Ref NameSet) (env : Environment) : IO Environment :=
  addTrustedTheorem env {
    name := value.name
    type := value.type
    levelParams := value.levelParams
    isUnsafe := false } trusted

def expressionDependencies (expr : Expr) : NameSet :=
  (expr.foldlM (m := Id) (fun names term => pure <| match term with
    | .const name _ | .proj name _ _ => names.insert name
    | _ => names) {} : Id NameSet).run

-- Match the assumptions accepted by Lean's standard library.
def allowedAxioms : List Name := [`propext, `Classical.choice, `Quot.sound]

-- Recheck proof terms and the local definitions they rely on with default
-- kernel options, independently of options used during notebook elaboration.
partial def recheckLocal (env : Environment) (pending : List Name)
    (seen : NameSet := {}) : Bool :=
  match pending with
  | [] => true
  | name :: rest =>
    if seen.contains name || (env.getModuleIdxFor? name).isSome then
      recheckLocal env rest seen
    else
      match env.find? name with
      | none => false
      | some info =>
        let fresh := Name.str name "_qnb_recheck"
        let candidate : Option Declaration := match info with
          | .thmInfo value => some (.thmDecl { value with name := fresh })
          | .defnInfo value => some (.defnDecl { value with name := fresh })
          | .opaqueInfo value => some (.opaqueDecl { value with name := fresh })
          | _ => none
        let valid := candidate.all fun decl =>
          (env.addDecl {} decl).isOk
        valid && recheckLocal env (info.getUsedConstantsAsSet.toList ++ rest) (seen.insert name)

def usedAxioms (env : Environment) (name : Name) : List Name :=
  let (_, state) := ((Elab.Command.CollectAxioms.collect name).run env).run {}
  state.axioms.toList

def verified (env : Environment) (name : Name) (trusted : NameSet) (axioms : List Name) : Bool :=
  axioms.all (fun axiomName =>
    allowedAxioms.contains axiomName || trusted.contains axiomName)
    && recheckLocal env [name]

def declaration (env : Environment) (name : Name) (info : ConstantInfo) (trusted : NameSet) : Option Json := do
  let range ← (declRangeExt.find? env name).map (·.range)
  let dependencies := info.getUsedConstantsAsSet.toList
  let axioms := usedAxioms env name
  if !verified env name trusted axioms || info.isUnsafe || info.isPartial then none else
    let names := (dependencies.filter fun name =>
      match env.find? name with
      | some (.thmInfo _) => true
      | some (.axiomInfo _) => trusted.contains name
      | _ => false).eraseDups.map Name.toString
    let statement := match info with
      | .thmInfo value => toJson ({ name, type := value.type, levelParams := value.levelParams,
                                    line := range.pos.line,
                                    needsContext := (expressionDependencies value.type).toList.any
                                      (fun dep => (env.getModuleIdxFor? dep).isNone) } : SavedStatement)
      | _ => Json.null
    some <| Json.mkObj [
      ("statement", statement),
      ("name", toJson name.toString),
      ("startLine", toJson range.pos.line),
      ("startColumn", toJson range.pos.column),
      ("endLine", toJson range.endPos.line),
      ("endColumn", toJson range.endPos.column),
      ("axioms", toJson (axioms.filter allowedAxioms.contains |>.map Name.toString)),
      ("dependencies", toJson names)]

inductive SavedDeclaration where
  | entry (name source : String) (prerequisites : List SavedDeclaration) (line : Nat)
      (statements : List SavedStatement)
  deriving FromJson

private partial def processWithRestores (actions : List (Nat × (Environment → IO Environment))) :
    Elab.Frontend.FrontendM Unit := do
  if actions.isEmpty then
    Elab.Frontend.processCommands
  else
    let ctx ← Elab.Frontend.getInputContext
    let state ← Elab.Frontend.getCommandState
    let parser ← Elab.Frontend.getParserState
    let scope := state.scopes.head!
    let parserCtx := { env := state.env, options := scope.opts, currNamespace := scope.currNamespace,
                       openDecls := scope.openDecls : Parser.ParserModuleContext }
    let (command, _, _) := Parser.parseCommand ctx parserCtx parser state.messages
    let lastLine := (ctx.fileMap.toPosition (command.getTailPos?.getD parser.pos)).line
    let (ready, later) := actions.partition (fun action => action.1 ≤ lastLine)
    let env ← ready.foldlM (fun env action => liftM (action.2 env)) state.env
    Elab.Frontend.setCommandState { state with env }
    unless ← Elab.Frontend.processCommand do
      processWithRestores later

def frontend (source fileName : String) (extraImports : Array Import := #[])
    (actions : List (Nat × (Environment → IO Environment)) := []) : IO (Environment × MessageLog) := do
  let ctx := Parser.mkInputContext source fileName
  let (header, parserState, messages) ← Parser.parseHeader ctx
  let opts := ({} : Options).setNat `maxHeartbeats 200000
  let env ← importModules (leakEnv := true) (Elab.headerToImports header ++ extraImports) opts
  let commandState := Elab.Command.mkState (env.setMainModule `Notebook) messages opts
  let ordered := (actions.toArray.mapIdx fun i action => (i, action)).qsort fun a b =>
    (a.2.1 < b.2.1) || (a.2.1 == b.2.1 && a.1 < b.1)
  let (_, result) ← ((processWithRestores (ordered.toList.map Prod.snd)).run { inputCtx := ctx }).run {
    commandState, parserState, cmdPos := parserState.pos
  }
  return (result.commandState.env, result.commandState.messages)

partial def savedImports (saved : SavedDeclaration) : IO (Array Import) := do
  let .entry _ source prerequisites _ _ := saved
  let (imports, _, _) ← Elab.parseImports source
  prerequisites.foldlM (fun acc item => do return acc ++ (← savedImports item)) imports

partial def registerParents (env : Environment) (name : Name) : Environment :=
  match name with
  | .anonymous => env
  | _ => registerParents (env.registerNamespace name) name.getPrefix

def declarationValue (info : ConstantInfo) : Option Expr :=
  match info with
  | .opaqueInfo value => some value.value
  | _ => info.value?

def inductiveDeclaration (origin : Environment) (value : InductiveVal) :
    IO (Declaration × NameSet) := do
  let types ← value.all.mapM fun name => do
    let some (.inductInfo info) := origin.find? name |
      throw (IO.userError s!"Missing inductive type {name}")
    let ctors ← info.ctors.mapM fun ctor => do
      let some (.ctorInfo info) := origin.find? ctor |
        throw (IO.userError s!"Missing constructor {ctor}")
      pure ({ name := ctor, type := info.type } : Constructor)
    pure ({ name, type := info.type, ctors } : InductiveType)
  let references := types.foldl (fun acc type =>
    type.ctors.foldl (fun acc ctor => acc ++ ctor.type.getUsedConstantsAsSet)
      (acc ++ type.type.getUsedConstantsAsSet)) ({} : NameSet)
  return (.inductDecl value.levelParams value.numParams types value.isUnsafe,
          references.toList.foldl (fun acc name =>
            if value.all.contains name then acc else acc.insert name) {})

-- Transfer the checked declaration and its local kernel dependencies.
partial def transfer (origin target : Environment) (name : Name)
    (originTrusted : NameSet) (targetTrusted : IO.Ref NameSet) (pending : NameSet := {}) :
    IO Environment := do
  if (origin.getModuleIdxFor? name).isSome then return target
  let some info := origin.find? name | throw (IO.userError s!"Missing declaration {name}")
  let isTrusted := originTrusted.contains name
  let existingDecl := target.find? name
  if let some existing := existingDecl then
    let alreadyTrusted := (← targetTrusted.get).contains name
    let sameDeclaration := declarationValue existing == declarationValue info
    let validTheorem := match existing with
      | .thmInfo _ => isTrusted
      | .axiomInfo _ => isTrusted && alreadyTrusted
      | _ => false
    let allowed := match info with
      | .axiomInfo _ => validTheorem
      | _ => sameDeclaration
    unless existing.type == info.type && existing.levelParams == info.levelParams && allowed do
      throw (IO.userError s!"Conflicting stored declaration {name}")
  if pending.contains name || info.isUnsafe || info.isPartial then
    throw (IO.userError s!"Cannot restore declaration {name}")
  let pending := pending.insert name
  if let .ctorInfo ctor := info then
    return ← transfer origin target ctor.induct originTrusted targetTrusted pending
  if let .recInfo recursor := info then
    let rebuilt ← recursor.all.foldlM (fun env decl => transfer origin env decl originTrusted targetTrusted pending) target
    if (rebuilt.find? name).isSome then return rebuilt
    throw (IO.userError s!"Cannot restore recursor {name}")
  let dependencies := expressionDependencies info.type ++
    ((declarationValue info).map expressionDependencies).getD {}
  let (decl, dependencies) ← match info with
    | .axiomInfo value =>
      if isTrusted then pure (.axiomDecl value, dependencies)
      else throw (IO.userError s!"Untrusted assumption {name}")
    | .defnInfo value => pure (.defnDecl value, dependencies)
    | .opaqueInfo value => pure (.opaqueDecl value, dependencies)
    | .inductInfo value => inductiveDeclaration origin value
    | _ => throw (IO.userError s!"Unsupported dependency of stored declaration: {name}")
  let target ← dependencies.toList.foldlM (fun env dep => transfer origin env dep originTrusted targetTrusted pending) target
  if existingDecl.isSome then return target
  if let .axiomDecl value := decl then
    return registerParents (← addTrustedTheorem target value targetTrusted) name.getPrefix
  match target.addDecl {} decl with
  | .ok env => return registerParents env name.getPrefix
  | .error _ => throw (IO.userError s!"Kernel rejected stored declaration {name}")

partial def restore (saved : SavedDeclaration) (targetTrusted : IO.Ref NameSet) (target : Environment) : IO Environment := do
  let .entry name source prerequisites _ statements := saved
  if let some statement := statements.find? (fun statement => statement.name.toString == name) then
    if !statement.needsContext && (target.find? statement.name).isNone then
      return registerParents (← restoreStatement statement targetTrusted target) statement.name.getPrefix
  let imports ← savedImports saved
  let originTrusted ← IO.mkRef ({} : NameSet)
  let dependencies := prerequisites.map fun item =>
    let .entry _ _ _ line _ := item
    (line, restore item originTrusted)
  let assumptions := statements.map fun statement => (statement.line, restoreStatement statement originTrusted)
  let (origin, messages) ← frontend source "<QNB archive>" imports (dependencies ++ assumptions)
  let trusted ← originTrusted.get
  if messages.hasErrors || !verified origin name.toName trusted (usedAxioms origin name.toName) then
    throw (IO.userError s!"Could not load stored declaration {name}")
  transfer origin target name.toName trusted targetTrusted

def main (args : List String) : IO UInt32 := do
  let (source, report, archives, started) ← match args with
    | [source, report] => pure (source, report, [], "")
    | source :: report :: input :: rest =>
      match (Json.parse (← IO.FS.readFile input)).bind (fromJson? (α := List SavedDeclaration)) with
      | .ok archives => pure (source, report, archives, rest.headD "")
      | .error error => throw (IO.userError error)
    | _ => throw (IO.userError "Expected source and report paths")
  unless started.isEmpty do
    let stdout ← IO.getStdout
    stdout.putStrLn started
    stdout.flush
  let input ← IO.FS.readFile source
  let imports ← archives.foldlM (fun acc item => do return acc ++ (← savedImports item)) #[]
  let recoveredRef ← IO.mkRef ({} : NameSet)
  let trustedRef ← IO.mkRef ({} : NameSet)
  let originsRef ← IO.mkRef (#[] : Array Json)
  let actions := archives.map fun saved =>
    let .entry root _ _ line _ := saved
    (line, fun env => do
      let restored ← restore saved trustedRef env
      let added := restored.constants.fold (fun names name _ =>
        if (env.find? name).isNone then names.insert name else names) ({} : NameSet)
      recoveredRef.modify (· ++ added)
      originsRef.modify (·.push (Json.mkObj [
        ("root", toJson root), ("names", toJson (added.toList.map Name.toString))]))
      return restored)
  let (env, messages) ← frontend input source imports actions
  let recovered ← recoveredRef.get
  let trusted ← trustedRef.get
  let origins ← originsRef.get
  let diagnostics ← messages.toList.mapM Message.toJson
  let (rows, defs, rejected) := env.constants.fold (fun (rows, defs, rejected) name info =>
    if (env.getModuleIdxFor? name).isSome || recovered.contains name then (rows, defs, rejected)
    else
      match info with
      | .thmInfo _ =>
        match declaration env name info trusted with
        | some row => (rows.push row, defs, rejected)
        | none =>
          if (declRangeExt.find? env name).isSome then (rows, defs, rejected.push name.toString)
          else (rows, defs, rejected)
      | .defnInfo _ | .opaqueInfo _ | .inductInfo _ =>
        match declaration env name info trusted with
        | some row => (rows, defs.push row, rejected)
        | none => (rows, defs, rejected)
      | _ => (rows, defs, rejected)) ((#[] : Array Json), (#[] : Array Json), (#[] : Array String))
  let payload := Json.mkObj [
    ("ok", toJson (!messages.hasErrors)), ("diagnostics", toJson diagnostics),
    ("declarations", toJson (if messages.hasErrors then #[] else rows)),
    ("definitions", toJson (if messages.hasErrors then #[] else defs)),
    ("recovered", toJson origins), ("rejected", toJson rejected)]
  IO.FS.writeFile report payload.compress
  return 0
