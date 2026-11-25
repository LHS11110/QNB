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

def expressionDependencies (expr : Expr) : NameSet :=
  collect expr {}
where
  collect (term : Expr) (names : NameSet) : NameSet :=
    match term with
    | .const name _ => names.insert name
    | .proj name _ value => collect value (names.insert name)
    | .app fn arg => collect arg (collect fn names)
    | .lam _ type body _ | .forallE _ type body _ => collect body (collect type names)
    | .letE _ type value body _ => collect body (collect value (collect type names))
    | .mdata _ value => collect value names
    | _ => names

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
          | .axiomInfo value => some (.axiomDecl { value with name := fresh })
          | _ => none
        let valid := candidate.all fun decl =>
          (env.addDecl {} decl).isOk
        valid && recheckLocal env (info.getUsedConstantsAsSet.toList ++ rest) (seen.insert name)

def usedAxioms (env : Environment) (name : Name) : List Name :=
  let (_, state) := ((Elab.Command.CollectAxioms.collect name).run env).run {}
  state.axioms.toList

def verified (env : Environment) (name : Name) (axioms : List Name)
    (extraAxioms : NameSet := {}) : Bool :=
  axioms.all (fun ax => allowedAxioms.contains ax || extraAxioms.contains ax) && recheckLocal env [name]

def rejectionReason (env : Environment) (name : Name) (info : ConstantInfo)
    (extraAxioms : NameSet := {}) : String :=
  if info.isUnsafe then "unsafe 선언"
  else if info.isPartial then "partial 선언"
  else
    let axioms := usedAxioms env name
    if axioms.contains `sorryAx then "sorry(미완성 증명) 사용"
    else if axioms.contains `Lean.ofReduceBool || axioms.contains `Lean.trustCompiler then
      "native_decide(컴파일러 공리) 사용"
    else
      let disallowed := axioms.filter fun ax => !allowedAxioms.contains ax && !extraAxioms.contains ax
      if !disallowed.isEmpty then
        s!"미등록 공리 참조 ({String.intercalate ", " (disallowed.map Name.toString)})"
      else if !recheckLocal env [name] then "커널 재검증 실패"
      else "검증 조건 미충족"

def declaration (env : Environment) (name : Name) (info : ConstantInfo)
    (extraAxioms : NameSet := {}) : Option Json := do
  let range ← (declRangeExt.find? env name).map (·.range)
  let dependencies := info.getUsedConstantsAsSet.toList
  let axioms := usedAxioms env name
  let axiomSet := match info with
    | .axiomInfo _ => extraAxioms.insert name
    | _ => extraAxioms
  if !verified env name axioms axiomSet || info.isUnsafe || info.isPartial then none else
    let names := (dependencies.filter fun dep =>
      match env.find? dep with
      | some (.thmInfo _) => true
      | some (.axiomInfo _) => extraAxioms.contains dep
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
      (statements : List SavedStatement) (isAxiom : Bool := false)

partial def parseSavedDeclaration (json : Json) : Except String SavedDeclaration := do
  let obj ← json.getObjVal? "entry"
  let name ← (← obj.getObjVal? "name").getStr?
  let source ← (← obj.getObjVal? "source").getStr?
  let prereqArr ← (← obj.getObjVal? "prerequisites").getArr?
  let prerequisites ← prereqArr.toList.mapM parseSavedDeclaration
  let line ← (← obj.getObjVal? "line").getNat?
  let stmtJson ← obj.getObjVal? "statements"
  let statements ← fromJson? (α := List SavedStatement) stmtJson
  let isAxiom ← match obj.getObjVal? "isAxiom" with
    | .ok val => val.getBool?
    | .error _ => pure false
  return .entry name source prerequisites line statements isAxiom

instance : FromJson SavedDeclaration := ⟨parseSavedDeclaration⟩

private def archiveQuery (command : Syntax) : Bool :=
  [`Lean.Parser.Command.eval, `Lean.Parser.Command.check, `Lean.Parser.Command.check_failure,
   `Lean.Parser.Command.print, `Lean.Parser.Command.printAxioms, `Lean.Parser.Command.printEqns,
   `Lean.Parser.Command.synth, `Lean.Parser.Command.reduce].contains command.getKind

private partial def processWithRestores (actions : List (Nat × (Environment → IO Environment)))
    (replay : Bool) :
    Elab.Frontend.FrontendM Unit := do
  if actions.isEmpty && !replay then
    Elab.Frontend.processCommands
  else
    let ctx ← Elab.Frontend.getInputContext
    let state ← Elab.Frontend.getCommandState
    let parser ← Elab.Frontend.getParserState
    let scope := state.scopes.head!
    let parserCtx := { env := state.env, options := scope.opts, currNamespace := scope.currNamespace,
                       openDecls := scope.openDecls : Parser.ParserModuleContext }
    let (command, next, messages) := Parser.parseCommand ctx parserCtx parser state.messages
    if replay && archiveQuery command then
      Elab.Frontend.setParserState next
      Elab.Frontend.setMessages messages
      return ← processWithRestores actions replay
    let lastLine := (ctx.fileMap.toPosition (command.getTailPos?.getD parser.pos)).line
    let (ready, later) := actions.partition (fun action => action.1 ≤ lastLine)
    let env ← ready.foldlM (fun env action => liftM (action.2 env)) state.env
    Elab.Frontend.setCommandState { state with env }
    unless ← Elab.Frontend.processCommand do
      processWithRestores later replay

def frontend (base : Environment) (source fileName : String)
    (actions : List (Nat × (Environment → IO Environment)) := [])
    (replay := false) : IO (Environment × MessageLog) := do
  let ctx := Parser.mkInputContext source fileName
  let (_, parserState, messages) ← Parser.parseHeader ctx
  let opts := (({} : Options).setNat `maxHeartbeats 200000).setBool `autoImplicit replay
  let commandState := Elab.Command.mkState (base.setMainModule `Notebook) messages opts
  let ordered := (actions.toArray.mapIdx fun i action => (i, action)).qsort fun a b =>
    (a.2.1 < b.2.1) || (a.2.1 == b.2.1 && a.1 < b.1)
  let (_, result) ← ((processWithRestores (ordered.toList.map Prod.snd) replay).run { inputCtx := ctx }).run {
    commandState, parserState, cmdPos := parserState.pos
  }
  return (result.commandState.env, result.commandState.messages)

partial def savedImports (saved : SavedDeclaration) : IO (Array Import) := do
  let .entry _ source prerequisites _ _ _ := saved
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
    (pending : NameSet := {}) (restoredAxiomsRef : Option (IO.Ref NameSet) := none)
    (allowAxiom : Bool := false) :
    IO Environment := do
  if (origin.getModuleIdxFor? name).isSome then return target
  let some info := origin.find? name | throw (IO.userError s!"Missing declaration {name}")
  let existingDecl := target.find? name
  if let some existing := existingDecl then
    let allowed := match existing, info with
      | .thmInfo _, .thmInfo _ => true
      | .axiomInfo _, .axiomInfo _ => allowAxiom
      | _, _ => declarationValue existing == declarationValue info
    unless existing.type == info.type && existing.levelParams == info.levelParams && allowed do
      throw (IO.userError s!"Conflicting stored declaration {name}")
    return target
  if pending.contains name || info.isUnsafe || info.isPartial then
    throw (IO.userError s!"Cannot restore declaration {name}")
  let pending := pending.insert name
  if let .ctorInfo ctor := info then
    return ← transfer origin target ctor.induct pending restoredAxiomsRef allowAxiom
  if let .recInfo recursor := info then
    let rebuilt ← recursor.all.foldlM (fun env decl => transfer origin env decl pending restoredAxiomsRef allowAxiom) target
    if (rebuilt.find? name).isSome then return rebuilt
    throw (IO.userError s!"Cannot restore recursor {name}")
  let dependencies := expressionDependencies info.type ++
    ((declarationValue info).map expressionDependencies).getD {}
  let (decl, dependencies) ← match info with
    | .thmInfo value => pure (.thmDecl value, dependencies)
    | .defnInfo value => pure (.defnDecl value, dependencies)
    | .opaqueInfo value => pure (.opaqueDecl value, dependencies)
    | .axiomInfo value =>
      if allowAxiom then pure (.axiomDecl value, dependencies)
      else throw (IO.userError s!"Cannot restore unapproved axiom {name}")
    | .inductInfo value => inductiveDeclaration origin value
    | _ => throw (IO.userError s!"Unsupported dependency of stored declaration: {name}")
  let target ← dependencies.toList.foldlM (fun env dep => transfer origin env dep pending restoredAxiomsRef allowAxiom) target
  match target.addDecl {} decl with
  | .ok env =>
    if let .axiomInfo _ := info then
      if let some ref := restoredAxiomsRef then
        ref.modify (·.insert name)
    let env := if let some structureInfo := getStructureInfo? origin name then
      structureExt.addEntry env structureInfo else env
    let env := if let some proj := origin.getProjectionFnInfo? name then
      addProjectionFnInfo env name proj.ctorName proj.numParams proj.i proj.fromClass else env
    return registerParents env name.getPrefix
  | .error error =>
    let reason := match error with
      | .unknownConstant _ missing => s!"unknown constant {missing}"
      | .alreadyDeclared _ duplicate => s!"already declared {duplicate}"
      | .declTypeMismatch .. => "type mismatch"
      | .appTypeMismatch .. => "application type mismatch"
      | .invalidProj .. => "invalid projection"
      | .other message => message
      | _ => "declaration failed kernel checking"
    throw (IO.userError s!"Kernel rejected stored declaration {name}: {reason}")

partial def restore (base : Environment) (saved : SavedDeclaration) (target : Environment)
    (restoredAxiomsRef : IO.Ref NameSet) : IO Environment := do
  let .entry name source prerequisites _ statements isAxiom := saved
  if (target.find? name.toName).isSome then return target
  unless statements.isEmpty do
    throw (IO.userError s!"Missing original proof source for {name}")
  let dependencies := prerequisites.map fun item =>
    let .entry _ _ _ line _ _ := item
    (line, fun env => restore base item env restoredAxiomsRef)
  let (origin, messages) ← frontend base source "<QNB archive>" dependencies true
  let currentAxioms ← restoredAxiomsRef.get
  let allowedForArchive := if isAxiom then currentAxioms.insert name.toName else currentAxioms
  if messages.hasErrors || !verified origin name.toName (usedAxioms origin name.toName) allowedForArchive then
    throw (IO.userError s!"Could not load stored declaration {name}")
  transfer origin target name.toName {} (some restoredAxiomsRef) isAxiom

def main (args : List String) : IO UInt32 := do
  if (← searchPathRef.get).isEmpty then
    initSearchPath (← findSysroot)
  let allowLocalAxioms := args.contains "allow-local-axioms"
  let cleanArgs := args.filter (· != "allow-local-axioms")
  let (source, report, archives, started) ← match cleanArgs with
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
  let ctx := Parser.mkInputContext input source
  let (header, _, _) ← Parser.parseHeader ctx
  let imports ← archives.foldlM (fun acc item => do return acc ++ (← savedImports item))
    (Elab.headerToImports header)
  let base ← importModules (leakEnv := true) imports {}
  let recoveredRef ← IO.mkRef ({} : NameSet)
  let restoredAxiomsRef ← IO.mkRef ({} : NameSet)
  let originsRef ← IO.mkRef (#[] : Array Json)
  let actions := archives.map fun saved =>
    let .entry root _ _ line _ _ := saved
    (line, fun env => do
      let restored ← restore base saved env restoredAxiomsRef
      let added := restored.constants.map₂.foldl (fun names name _ =>
        if (env.find? name).isNone then names.insert name else names) ({} : NameSet)
      recoveredRef.modify (· ++ added)
      originsRef.modify (·.push (Json.mkObj [
        ("root", toJson root), ("names", toJson (added.toList.map Name.toString))]))
      return restored)
  let (env, messages) ← frontend base input source actions
  let recovered ← recoveredRef.get
  let restoredAxioms ← restoredAxiomsRef.get
  let origins ← originsRef.get
  let diagnostics ← messages.toList.mapM Message.toJson
  let (rows, defs, customAxioms, rejected, rejectedReasons, localAxioms) :=
    env.constants.map₂.foldl (fun (rows, defs, customAxioms, rejected, rejectedReasons, localAxioms) name info =>
      if (env.getModuleIdxFor? name).isSome || recovered.contains name then
        (rows, defs, customAxioms, rejected, rejectedReasons, localAxioms)
      else
        match info with
        | .thmInfo _ =>
          match declaration env name info restoredAxioms with
          | some row => (rows.push row, defs, customAxioms, rejected, rejectedReasons, localAxioms)
          | none =>
            if (declRangeExt.find? env name).isSome then
              let reason := rejectionReason env name info restoredAxioms
              let detail := Json.mkObj [("name", toJson name.toString), ("reason", toJson reason)]
              (rows, defs, customAxioms, rejected.push name.toString, rejectedReasons.push detail, localAxioms)
            else
              (rows, defs, customAxioms, rejected, rejectedReasons, localAxioms)
        | .defnInfo _ | .opaqueInfo _ | .inductInfo _ =>
          match declaration env name info restoredAxioms with
          | some row => (rows, defs.push row, customAxioms, rejected, rejectedReasons, localAxioms)
          | none => (rows, defs, customAxioms, rejected, rejectedReasons, localAxioms)
        | .axiomInfo _ =>
          if (declRangeExt.find? env name).isSome then
            if allowLocalAxioms then
              match declaration env name info restoredAxioms with
              | some row => (rows, defs, customAxioms.push row, rejected, rejectedReasons, localAxioms)
              | none => (rows, defs, customAxioms, rejected, rejectedReasons, localAxioms)
            else
              (rows, defs, customAxioms, rejected, rejectedReasons, localAxioms.push name.toString)
          else
            (rows, defs, customAxioms, rejected, rejectedReasons, localAxioms)
        | _ => (rows, defs, customAxioms, rejected, rejectedReasons, localAxioms))
      ((#[] : Array Json), (#[] : Array Json), (#[] : Array Json), (#[] : Array String), (#[] : Array Json), (#[] : Array String))
  let payload := Json.mkObj [
    ("ok", toJson (!messages.hasErrors)), ("diagnostics", toJson diagnostics),
    ("declarations", toJson (if messages.hasErrors then #[] else rows)),
    ("definitions", toJson (if messages.hasErrors then #[] else defs)),
    ("customAxioms", toJson (if messages.hasErrors then #[] else customAxioms)),
    ("recovered", toJson origins), ("rejected", toJson rejected),
    ("rejectedReasons", toJson (if messages.hasErrors then #[] else rejectedReasons)),
    ("localAxioms", toJson (if messages.hasErrors then #[] else localAxioms))]
  IO.FS.writeFile report payload.compress
  return 0
