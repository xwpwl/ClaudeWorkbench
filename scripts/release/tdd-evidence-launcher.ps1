param(
  [Parameter(Mandatory = $true)][ValidateSet('red', 'green')][string] $Phase,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Z0-9,-]+$')][string] $CaseIds,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z-]+$')][string] $CommandId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9+/]+={0,2}$')][string] $ChildArgumentsBase64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Stop-Launcher {
  [Console]::Error.WriteLine('Trusted TDD evidence launcher failed.')
  exit 1
}

$script:NativeFileApi = $null

function Get-NativeFileApi {
  if ($null -ne $script:NativeFileApi) { return $script:NativeFileApi }

  $assemblyName = [Reflection.AssemblyName]::new('WorkbenchTddEvidenceNativeApi')
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module = $assembly.DefineDynamicModule('WorkbenchTddEvidenceNativeApi')
  $type = $module.DefineType(
    'WorkbenchTddEvidenceNativeMethods',
    [Reflection.TypeAttributes]::Public -bor [Reflection.TypeAttributes]::Sealed -bor [Reflection.TypeAttributes]::Abstract
  )
  $methodAttributes = [Reflection.MethodAttributes]::Public -bor
    [Reflection.MethodAttributes]::Static -bor
    [Reflection.MethodAttributes]::PinvokeImpl
  $getFileInformation = $type.DefinePInvokeMethod(
    'GetFileInformationByHandleEx',
    'kernel32.dll',
    $methodAttributes,
    [Reflection.CallingConventions]::Standard,
    [bool],
    [Type[]]@([IntPtr], [int], [IntPtr], [uint32]),
    [Runtime.InteropServices.CallingConvention]::Winapi,
    [Runtime.InteropServices.CharSet]::Unicode
  )
  $getFileInformation.SetImplementationFlags($getFileInformation.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
  $getFinalPath = $type.DefinePInvokeMethod(
    'GetFinalPathNameByHandleW',
    'kernel32.dll',
    $methodAttributes,
    [Reflection.CallingConventions]::Standard,
    [uint32],
    [Type[]]@([IntPtr], [Text.StringBuilder], [uint32], [uint32]),
    [Runtime.InteropServices.CallingConvention]::Winapi,
    [Runtime.InteropServices.CharSet]::Unicode
  )
  $getFinalPath.SetImplementationFlags($getFinalPath.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
  $createJobObject = $type.DefinePInvokeMethod(
    'CreateJobObjectW',
    'kernel32.dll',
    $methodAttributes,
    [Reflection.CallingConventions]::Standard,
    [IntPtr],
    [Type[]]@([IntPtr], [string]),
    [Runtime.InteropServices.CallingConvention]::Winapi,
    [Runtime.InteropServices.CharSet]::Unicode
  )
  $createJobObject.SetImplementationFlags($createJobObject.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
  foreach ($definition in @(
    @('SetInformationJobObject', [bool], [Type[]]@([IntPtr], [int], [IntPtr], [uint32])),
    @('QueryInformationJobObject', [bool], [Type[]]@([IntPtr], [int], [IntPtr], [uint32], [IntPtr])),
    @('AssignProcessToJobObject', [bool], [Type[]]@([IntPtr], [IntPtr])),
    @('TerminateJobObject', [bool], [Type[]]@([IntPtr], [uint32])),
    @('CloseHandle', [bool], [Type[]]@([IntPtr]))
  )) {
    $method = $type.DefinePInvokeMethod(
      $definition[0],
      'kernel32.dll',
      $methodAttributes,
      [Reflection.CallingConventions]::Standard,
      $definition[1],
      $definition[2],
      [Runtime.InteropServices.CallingConvention]::Winapi,
      [Runtime.InteropServices.CharSet]::Unicode
    )
    $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
  }
  $script:NativeFileApi = $type.CreateType()
  return $script:NativeFileApi
}

function Assert-NonReparsePath {
  param(
    [Parameter(Mandatory = $true)][string] $LiteralPath,
    [Parameter(Mandatory = $true)][bool] $RequireFile
  )

  if (-not [IO.Path]::IsPathRooted($LiteralPath)) { throw 'Path must be absolute.' }
  $fullPath = [IO.Path]::GetFullPath($LiteralPath)
  $root = [IO.Path]::GetPathRoot($fullPath)
  $current = $root
  foreach ($component in $fullPath.Substring($root.Length).Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [IO.Path]::Combine($current, $component)
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Trusted paths must not traverse a reparse point.'
    }
  }
  $resolved = (Resolve-Path -LiteralPath $fullPath).ProviderPath
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($resolved), $fullPath)) {
    throw 'Trusted paths must be canonical.'
  }
  $final = Get-Item -LiteralPath $fullPath -Force
  if ($RequireFile -and $final.PSIsContainer) { throw 'Trusted executable/input must be a regular file.' }
  if (-not $RequireFile -and -not $final.PSIsContainer) { throw 'Trusted workspace must be a directory.' }
  return $fullPath
}

function Ensure-ContainedDirectory {
  param(
    [Parameter(Mandatory = $true)][string] $WorkspaceRoot,
    [Parameter(Mandatory = $true)][string] $DirectoryPath
  )

  $workspace = [IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $directory = [IO.Path]::GetFullPath($DirectoryPath)
  if (-not $directory.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Temporary directory must stay inside the workspace.'
  }
  $relative = $directory.Substring($workspace.Length).TrimStart([IO.Path]::DirectorySeparatorChar)
  $current = $workspace
  foreach ($component in $relative.Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [IO.Path]::Combine($current, $component)
    if (-not [IO.Directory]::Exists($current)) {
      [IO.Directory]::CreateDirectory($current) | Out-Null
    }
    Assert-NonReparsePath -LiteralPath $current -RequireFile $false | Out-Null
  }
  return $directory
}

function ConvertTo-WindowsArgument {
  param([AllowEmptyString()][string] $Value)

  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = [Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $backslashes += 1
      continue
    }
    if ($character -eq '"') {
      [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
      [void]$builder.Append('"')
    } else {
      if ($backslashes -gt 0) { [void]$builder.Append(('\' * $backslashes)) }
      [void]$builder.Append($character)
    }
    $backslashes = 0
  }
  if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Get-Sha256FromStream {
  param([Parameter(Mandatory = $true)][IO.FileStream] $Stream)

  $Stream.Position = 0
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Read-StrictUtf8FromStream {
  param([Parameter(Mandatory = $true)][IO.FileStream] $Stream)

  $Stream.Position = 0
  $reader = [IO.StreamReader]::new($Stream, [Text.UTF8Encoding]::new($false, $true), $false, 4096, $true)
  try {
    return $reader.ReadToEnd()
  } finally {
    $reader.Dispose()
  }
}

function Get-FileHandleFacts {
  param([Parameter(Mandatory = $true)][IO.FileStream] $Stream)

  $nativeApi = Get-NativeFileApi
  $handle = $Stream.SafeFileHandle.DangerousGetHandle()
  $information = [Runtime.InteropServices.Marshal]::AllocHGlobal(24)
  try {
    if (-not $nativeApi::GetFileInformationByHandleEx($handle, 18, $information, 24)) {
      throw 'Could not bind the trusted file identity.'
    }
    $identityBytes = New-Object byte[] 24
    [Runtime.InteropServices.Marshal]::Copy($information, $identityBytes, 0, $identityBytes.Length)
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($information)
  }

  $pathBuffer = [Text.StringBuilder]::new(512)
  $pathLength = $nativeApi::GetFinalPathNameByHandleW($handle, $pathBuffer, [uint32]$pathBuffer.Capacity, 0)
  if ($pathLength -eq 0) { throw 'Could not bind the trusted file path.' }
  if ($pathLength -ge $pathBuffer.Capacity) {
    $pathBuffer = [Text.StringBuilder]::new([int]$pathLength + 1)
    $pathLength = $nativeApi::GetFinalPathNameByHandleW($handle, $pathBuffer, [uint32]$pathBuffer.Capacity, 0)
    if ($pathLength -eq 0 -or $pathLength -ge $pathBuffer.Capacity) {
      throw 'Could not bind the trusted file path.'
    }
  }
  $finalPath = $pathBuffer.ToString()
  if ($finalPath.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
    $finalPath = '\\' + $finalPath.Substring(8)
  } elseif ($finalPath.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
    $finalPath = $finalPath.Substring(4)
  }

  return [PSCustomObject]@{
    Identity = ([BitConverter]::ToString($identityBytes)).Replace('-', '').ToLowerInvariant()
    FinalPath = [IO.Path]::GetFullPath($finalPath)
  }
}

function Assert-IdentityBoundReadStream {
  param(
    [Parameter(Mandatory = $true)][string] $LiteralPath,
    [Parameter(Mandatory = $true)][IO.FileStream] $Stream,
    [Parameter(Mandatory = $true)][object] $ExpectedFacts
  )

  $expectedPath = Assert-NonReparsePath -LiteralPath $LiteralPath -RequireFile $true
  $heldFacts = Get-FileHandleFacts -Stream $Stream
  $shortStream = [IO.File]::Open($expectedPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $shortFacts = Get-FileHandleFacts -Stream $shortStream
    if (-not [StringComparer]::Ordinal.Equals($ExpectedFacts.Identity, $heldFacts.Identity) -or
        -not [StringComparer]::OrdinalIgnoreCase.Equals($ExpectedFacts.FinalPath, $heldFacts.FinalPath) -or
        -not [StringComparer]::Ordinal.Equals($heldFacts.Identity, $shortFacts.Identity) -or
        -not [StringComparer]::OrdinalIgnoreCase.Equals($heldFacts.FinalPath, $shortFacts.FinalPath) -or
        -not [StringComparer]::OrdinalIgnoreCase.Equals($heldFacts.FinalPath, $expectedPath)) {
      throw 'Trusted file identity or final path changed during validation.'
    }
  } finally {
    $shortStream.Dispose()
  }
}

function Open-IdentityBoundReadStream {
  param([Parameter(Mandatory = $true)][string] $LiteralPath)

  $expectedPath = Assert-NonReparsePath -LiteralPath $LiteralPath -RequireFile $true
  $longStream = [IO.File]::Open($expectedPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $longFacts = Get-FileHandleFacts -Stream $longStream
    Assert-IdentityBoundReadStream -LiteralPath $expectedPath -Stream $longStream -ExpectedFacts $longFacts
    return [PSCustomObject]@{
      Path = $expectedPath
      Stream = $longStream
      Identity = $longFacts.Identity
      FinalPath = $longFacts.FinalPath
    }
  } catch {
    $longStream.Dispose()
    throw
  }
}

function New-KillOnCloseJob {
  $nativeApi = Get-NativeFileApi
  $jobHandle = $nativeApi::CreateJobObjectW([IntPtr]::Zero, $null)
  if ($jobHandle -eq [IntPtr]::Zero) { throw 'Could not create trusted Node containment.' }
  $information = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
  try {
    $zeroBytes = New-Object byte[] 144
    [Runtime.InteropServices.Marshal]::Copy($zeroBytes, 0, $information, $zeroBytes.Length)
    [Runtime.InteropServices.Marshal]::WriteInt32($information, 16, 0x00002000)
    if (-not $nativeApi::SetInformationJobObject($jobHandle, 9, $information, 144)) {
      throw 'Could not configure trusted Node containment.'
    }
    return $jobHandle
  } catch {
    [void]$nativeApi::CloseHandle($jobHandle)
    throw
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($information)
  }
}

function Wait-ForEmptyJob {
  param([Parameter(Mandatory = $true)][IntPtr] $JobHandle)

  $nativeApi = Get-NativeFileApi
  $information = [Runtime.InteropServices.Marshal]::AllocHGlobal(48)
  try {
    while ($true) {
      $zeroBytes = New-Object byte[] 48
      [Runtime.InteropServices.Marshal]::Copy($zeroBytes, 0, $information, $zeroBytes.Length)
      if (-not $nativeApi::QueryInformationJobObject($JobHandle, 1, $information, 48, [IntPtr]::Zero)) {
        throw 'Could not confirm trusted Node containment exit.'
      }
      if ([Runtime.InteropServices.Marshal]::ReadInt32($information, 40) -eq 0) { return }
      [Threading.Thread]::Sleep(10)
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($information)
  }
}

function Open-ReadLock {
  param([Parameter(Mandatory = $true)][string] $LiteralPath)

  return [IO.File]::Open($LiteralPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
}

$heldStreams = [Collections.Generic.List[IDisposable]]::new()

try {
  $decodedVector = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ChildArgumentsBase64))
  $childArguments = [string[]]$decodedVector.Split([char]0)
  if ($childArguments.Count -eq 0) { throw 'The approved child vector is required.' }
  foreach ($childArgument in $childArguments) {
    if ($childArgument.Length -eq 0) { throw 'The approved child vector is required.' }
  }
  if ($env:npm_lifecycle_event -eq 'release:tdd-evidence') {
    throw 'npm is an unsupported recorder trust boundary.'
  }
  if (-not [Environment]::Is64BitProcess -or -not [Environment]::Is64BitOperatingSystem) {
    throw 'The approved Task 15 recorder toolchain is Windows x64 only.'
  }

  $systemDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)
  $windowsDirectory = [IO.Directory]::GetParent($systemDirectory).FullName
  $trustedPowerShell = [IO.Path]::Combine($systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  $trustedPowerShell = Assert-NonReparsePath -LiteralPath $trustedPowerShell -RequireFile $true
  $currentPowerShell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals($trustedPowerShell, [IO.Path]::GetFullPath($currentPowerShell))) {
    throw 'Launcher must run in the trusted System32 Windows PowerShell.'
  }

  $workspaceRoot = Assert-NonReparsePath -LiteralPath ([IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..'))) -RequireFile $false
  $launcherPath = Assert-NonReparsePath -LiteralPath $PSCommandPath -RequireFile $true
  if (-not $launcherPath.StartsWith($workspaceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Launcher must stay inside its workspace.'
  }
  $heldLauncher = Open-IdentityBoundReadStream -LiteralPath $launcherPath
  [void]$heldStreams.Add($heldLauncher.Stream)
  $contractPath = Assert-NonReparsePath -LiteralPath ([IO.Path]::Combine($PSScriptRoot, 'tdd-evidence-toolchain.json')) -RequireFile $true
  $cliPath = Assert-NonReparsePath -LiteralPath ([IO.Path]::Combine($PSScriptRoot, 'tdd-evidence.mjs')) -RequireFile $true
  $requirementsContractPath = Assert-NonReparsePath -LiteralPath ([IO.Path]::Combine($PSScriptRoot, 'requirements-contract.mjs')) -RequireFile $true
  Assert-NonReparsePath -LiteralPath ([IO.Path]::Combine($PSScriptRoot, 'lib', 'tdd-evidence.mjs')) -RequireFile $true | Out-Null

  $protectedInputHashes = [ordered]@{
    'scripts/release/tdd-evidence-toolchain.json' = '75f8495157afae85bd9c98232221576cbba9157b316c00a9639edec636936472'
    'scripts/release/tdd-evidence.mjs' = 'ea913e99264471456ddbe3577707f137e903e676928406b5c9fca6d1dbace8b6'
    'scripts/release/requirements-contract.mjs' = 'a105d1414beb8c9a7618031000fa4f370ac2566ee871f430904b1eb2929859e3'
    'scripts/release/lib/tdd-evidence.mjs' = '87fc61bee6ef1660552c30cc2cef3e7e4dc1916993379e4b2cfacff8bb2d36e7'
  }
  $protectedInputPaths = [ordered]@{
    'scripts/release/tdd-evidence-toolchain.json' = $contractPath
    'scripts/release/tdd-evidence.mjs' = $cliPath
    'scripts/release/requirements-contract.mjs' = $requirementsContractPath
    'scripts/release/lib/tdd-evidence.mjs' = [IO.Path]::Combine($PSScriptRoot, 'lib', 'tdd-evidence.mjs')
  }
  $protectedInputs = @{}
  foreach ($relativePath in $protectedInputPaths.Keys) {
    $protectedInput = Open-IdentityBoundReadStream -LiteralPath $protectedInputPaths[$relativePath]
    [void]$heldStreams.Add($protectedInput.Stream)
    $protectedInputs[$relativePath] = $protectedInput
  }
  foreach ($relativePath in $protectedInputPaths.Keys) {
    $protectedInputStream = $protectedInputs[$relativePath].Stream
    if ((Get-Sha256FromStream -Stream $protectedInputStream) -ne $protectedInputHashes[$relativePath]) {
      throw 'A trusted TDD evidence input does not match its approved hash.'
    }
  }

  $contractText = Read-StrictUtf8FromStream -Stream $protectedInputs['scripts/release/tdd-evidence-toolchain.json'].Stream
  $contractPattern = '\A\{\r?\n  "schemaVersion": 1,\r?\n  "platform": "win32",\r?\n  "architecture": "x64",\r?\n  "programFilesRelativeNodePath": "nodejs\\\\node\.exe",\r?\n  "nodeVersion": "(v\d+\.\d+\.\d+)",\r?\n  "nodeSha256": "([a-f0-9]{64})"\r?\n\}\r?\n?\z'
  $contractMatch = [Text.RegularExpressions.Regex]::Match($contractText, $contractPattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant)
  if (-not $contractMatch.Success) {
    throw 'The approved Node toolchain contract is invalid.'
  }
  $approvedNodeVersion = $contractMatch.Groups[1].Value
  $approvedNodeSha256 = $contractMatch.Groups[2].Value

  $programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
  $nodePath = Assert-NonReparsePath -LiteralPath ([IO.Path]::Combine($programFiles, 'nodejs', 'node.exe')) -RequireFile $true
  $heldNode = Open-IdentityBoundReadStream -LiteralPath $nodePath
  $nodeStream = $heldNode.Stream
  [void]$heldStreams.Add($nodeStream)
  $nodeItem = Get-Item -LiteralPath $nodePath -Force
  $nodeInvalid = ('v' + $nodeItem.VersionInfo.ProductVersion) -ne $approvedNodeVersion -or
    $nodeItem.VersionInfo.OriginalFilename -ne 'node.exe' -or
    (Get-Sha256FromStream -Stream $nodeStream) -ne $approvedNodeSha256
  if ($nodeInvalid) {
    throw 'The installed Node executable does not match the approved deterministic toolchain.'
  }

  $trustedCmd = Assert-NonReparsePath -LiteralPath ([IO.Path]::Combine($systemDirectory, 'cmd.exe')) -RequireFile $true
  [void]$heldStreams.Add((Open-ReadLock -LiteralPath $trustedPowerShell))
  [void]$heldStreams.Add((Open-ReadLock -LiteralPath $trustedCmd))
  $temporaryDirectory = Ensure-ContainedDirectory -WorkspaceRoot $workspaceRoot -DirectoryPath ([IO.Path]::Combine($workspaceRoot, 'release-validation', 'tdd', 'tmp'))

  $nonceBytes = New-Object byte[] 32
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($nonceBytes) } finally { $random.Dispose() }
  $nonce = ([BitConverter]::ToString($nonceBytes)).Replace('-', '').ToLowerInvariant()

  $recorderArguments = @('--phase', $Phase, '--case-ids', $CaseIds, '--command-id', $CommandId, '--') + $childArguments
  $arguments = @($cliPath) + $recorderArguments
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $nodePath
  $start.Arguments = [String]::Join(' ', @($arguments | ForEach-Object { ConvertTo-WindowsArgument -Value $_ }))
  $start.WorkingDirectory = $workspaceRoot
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $false
  $start.RedirectStandardError = $false
  $start.EnvironmentVariables.Clear()
  $start.EnvironmentVariables['SystemRoot'] = $windowsDirectory
  $start.EnvironmentVariables['WINDIR'] = $windowsDirectory
  $start.EnvironmentVariables['COMSPEC'] = $trustedCmd
  $start.EnvironmentVariables['TEMP'] = $temporaryDirectory
  $start.EnvironmentVariables['TMP'] = $temporaryDirectory
  $start.EnvironmentVariables['PATHEXT'] = '.COM;.EXE;.BAT;.CMD'
  $start.EnvironmentVariables['LANG'] = 'C'
  $start.EnvironmentVariables['LC_ALL'] = 'C'
  $start.EnvironmentVariables['WORKBENCH_TDD_LAUNCH_TOKEN'] = $nonce

  foreach ($relativePath in $protectedInputPaths.Keys) {
    $protectedInput = $protectedInputs[$relativePath]
    $expectedFacts = [PSCustomObject]@{
      Identity = $protectedInput.Identity
      FinalPath = $protectedInput.FinalPath
    }
    Assert-IdentityBoundReadStream -LiteralPath $protectedInput.Path -Stream $protectedInput.Stream -ExpectedFacts $expectedFacts
  }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  $processStarted = $false
  $processExitConfirmed = $false
  $processExitCode = 1
  $jobHandle = [IntPtr]::Zero
  $jobAssigned = $false
  try {
    $jobHandle = New-KillOnCloseJob
    $processStarted = $process.Start()
    if (-not $processStarted) { throw 'The trusted Node process did not start.' }
    try {
      $nativeApi = Get-NativeFileApi
      if (-not $nativeApi::AssignProcessToJobObject($jobHandle, $process.Handle)) {
        throw 'Could not contain the trusted Node process.'
      }
      $jobAssigned = $true
      $process.StandardInput.WriteLine($nonce)
      $process.StandardInput.Close()
      $process.WaitForExit()
      $processExitCode = $process.ExitCode
      Wait-ForEmptyJob -JobHandle $jobHandle
      $processExitConfirmed = $true
    } finally {
      if ($processStarted -and -not $processExitConfirmed) {
        try { $process.StandardInput.Close() } catch { }
        if ($jobAssigned) {
          [void]$nativeApi::TerminateJobObject($jobHandle, 1)
          Wait-ForEmptyJob -JobHandle $jobHandle
        } else {
          $killFailure = $null
          try {
            if (-not $process.HasExited) { $process.Kill() }
          } catch [InvalidOperationException] {
          } catch {
            $killFailure = $_
          }
          $process.WaitForExit()
          if ($null -ne $killFailure) { throw $killFailure }
        }
        if ($jobAssigned) { $process.WaitForExit() }
        $processExitConfirmed = $true
      }
    }
  } finally {
    $process.Dispose()
    if ($jobHandle -ne [IntPtr]::Zero) {
      $nativeApi = Get-NativeFileApi
      [void]$nativeApi::CloseHandle($jobHandle)
    }
  }
  exit $processExitCode
} catch {
  Stop-Launcher
} finally {
  foreach ($heldStream in $heldStreams) { $heldStream.Dispose() }
}
