# Generates the synthesised "pit wall" voice pack: one 16 kHz mono WAV per optional
# clip in src/grid.js, spoken by Windows TTS. These are original recordings that ship
# with the repo so the meme pack is fully populated; drop a real clip with the same
# stem (e.g. assets/clips/bwoah.mp3) and it takes precedence.
#
#   pwsh deploy/tools/make-voice-pack.ps1
Add-Type -AssemblyName System.Speech
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$out = Join-Path $root 'assets\clips'
New-Item -ItemType Directory -Force $out | Out-Null

# id -> [voice, rate, text]. Rate -10..10.
$lines = @{
  lightsout      = @('Microsoft George', 2,  "It's lights out, and away we go!")
  boxbox         = @('Microsoft George', 1,  'Box box. Box box.')
  hammertime     = @('Microsoft George', 0,  "It's hammer time.")
  bono           = @('Microsoft George', 0,  'Bono, my tyres are gone.')
  iamstupid      = @('Microsoft George', 2,  'I am stupid. I am stupid.')
  nomichaelno    = @('Microsoft George', 2,  'No Michael, no! No! That was so not right.')
  isthatglock    = @('Microsoft George', 3,  'Is that Glock?! Is that Glock going slowly?!')
  dudududu       = @('Microsoft George', 1,  'Du du du du, Max Verstappen. Du du du du du du du du.')
  simplylovely   = @('Microsoft George', -1, 'Simply lovely.')
  gp2engine      = @('Microsoft George', 3,  'GP2 engine! GP2! Aaargh!')
  smoothoperator = @('Microsoft George', -2, 'Smooooooth operator.')
  what           = @('Microsoft George', 4,  'WHAT?!')
  bwoah          = @('Microsoft George', -3, 'Bwoah.')
  leavemealone   = @('Microsoft George', 0,  "Leave me alone. I know what I'm doing.")
  itsjames       = @('Microsoft George', 0,  "Valtteri, it's James.")
  multi21        = @('Microsoft George', 0,  'Multi twenty one, Seb. Multi twenty one.')
  getinthere     = @('Microsoft George', 3,  'Get in there, Lewis!')
  wearechecking  = @('Microsoft George', -1, 'We are checking.')
  safetycar      = @('Microsoft George', 1,  'Safety car, safety car.')
  penalty        = @('Microsoft George', 2,  'Five second penalty? For what?! For WHAT?!')
  yesboys        = @('Microsoft George', 3,  'Yes boys! Yes!')
}

$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
foreach ($id in $lines.Keys | Sort-Object) {
  $voice, $rate, $text = $lines[$id]
  if ($voices -notcontains $voice) { $voice = $voices | Where-Object { $_ -like '*George*' -or $_ -like '*Hazel*' } | Select-Object -First 1 }
  $synth.SelectVoice($voice)
  $synth.Rate = $rate
  $synth.Volume = 100
  $file = Join-Path $out "$id.wav"
  $synth.SetOutputToWaveFile($file, $fmt)
  $synth.Speak($text)
  $synth.SetOutputToNull()
  '{0,-16} {1,7:N0} bytes  {2}' -f $id, (Get-Item $file).Length, $text
}
$synth.Dispose()
