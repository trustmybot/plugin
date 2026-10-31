#!/usr/bin/env perl
# Helper for enums-stable.sh.
# Usage: enums-stable-extract.pl <enum> <schema.sql> <file>...
# Prints "<value>\t<file>" for every literal of <enum> the schema CHECK lists
# and the code files hold, first occurrence per (value, file). Comments in
# .ts/.mjs/.js files are not code; a prefix test of 'hook:' is no from_node; a
# constant passed as insertAudit's event_type counts as its string value.
use strict;
use warnings;
use File::Basename qw(dirname);

my ($enum, $schema, @files) = @ARGV;

my $q   = qr/['"]/;
my $tok = qr/(?:"[^"\n]*"|'[^'\n]*'|[^\s"'\\]+)/;
my $sep = qr/(?:[ \t]|\\\n)+/;
my $end = qr/(?=[ \t\\\n;)])/;

my %check = (
  'tasks.status'                => ['tasks', 'status'],
  'issues.status'               => ['issues', 'status'],
  'validation_attempts.verdict' => ['validation_attempts', 'verdict'],
  'discussions.kind'            => ['discussions', 'kind'],
  'milestones.state'            => ['milestones', 'state'],
  'agent_runs.usage_source'     => ['agent_runs', 'usage_source'],
);

sub slurp {
  my $f = shift;
  open(my $fh, '<', $f) or return '';
  local $/;
  my $c = <$fh>;
  close $fh;
  return $c // '';
}

sub lits { my $s = shift; return ($s =~ /'([a-z][a-z0-9_-]*)'/g); }

# The source with its comments removed, keeping strings, templates and regex
# literals, where comment markers are text.
sub strip_js_comments {
  my $src = shift;
  my $out = '';
  my @interpolations;
  my $template_text = sub {
    $src =~ /\G((?:[^`\\\$]|\\.|\$(?!\{))*)/gcs;
    $out .= $1;
    if ($src =~ /\G`/gc) { $out .= '`'; }
    elsif ($src =~ /\G\$\{/gc) { $out .= '${'; push @interpolations, 0; }
  };
  pos($src) = 0;
  while (pos($src) < length $src) {
    if ($src =~ /\G\/\/[^\n]*/gc || $src =~ /\G\/\*.*?(?:\*\/|\z)/gcs) { $out .= ' '; next; }
    if ($src =~ /\G('(?:[^'\\\n]|\\.)*'?|"(?:[^"\\\n]|\\.)*"?)/gcs) { $out .= $1; next; }
    if ($src =~ /\G`/gc) { $out .= '`'; $template_text->(); next; }
    if (substr($out, -20) =~ /(?:^|[=(,:;!&|?{}\[+\-*%<>~^]|\breturn|\btypeof)\s*$/
        && $src =~ /\G(\/(?:[^\/\\\n\[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*)/gc) {
      $out .= $1;
      next;
    }
    if (@interpolations && $src =~ /\G\{/gc) { $interpolations[-1]++; $out .= '{'; next; }
    if (@interpolations && $src =~ /\G\}/gc) {
      $out .= '}';
      if ($interpolations[-1]-- == 0) { pop @interpolations; $template_text->(); }
      next;
    }
    $src =~ /\G(.)/gcs;
    $out .= $1;
  }
  return $out;
}

# The string value of constant <name> as <file> sees it: declared there, or
# followed through its relative imports and re-exports.
sub const_value {
  my ($file, $name, $seen) = @_;
  $seen //= {};
  return undef if $seen->{"$file\t$name"}++;
  my $c = strip_js_comments(slurp($file));
  return $1 if $c =~ /\bconst\s+\Q$name\E\b(?:\s*:[^=\n]+)?\s*=\s*['"]([a-z][a-z0-9_]*)['"]/;
  while ($c =~ /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g) {
    my ($names, $path) = ($1, $2);
    for my $spec (split /,/, $names) {
      next unless $spec =~ /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/;
      next unless ($2 // $1) eq $name;
      my $original = $1;
      (my $target = dirname($file) . "/$path") =~ s/\.js$/.ts/;
      return const_value($target, $original, $seen);
    }
  }
  return undef;
}

my @out;
sub emit { my ($f, @v) = @_; push @out, map { "$_\t$f" } @v; }

if (my $c = $check{$enum}) {
  my ($table, $col) = @$c;
  my $s = slurp($schema);
  if ($s =~ /CREATE TABLE (?:IF NOT EXISTS )?\Q$table\E\s*\((.*?)\n\s*\);/s) {
    my $block = $1;
    while ($block =~ /CHECK\s*\(\s*\Q$col\E\s+IN\s*\(([^)]*)\)/g) { emit($schema, lits($1)); }
  }
}

for my $f (@files) {
  my $c = slurp($f);
  $c =~ s/^[ \t]*#(?!!).*$//mg if $f =~ /\.sh$/;
  $c = strip_js_comments($c) if $f =~ /\.(?:ts|mjs|js)$/;

  if ($enum eq 'audit.event_type') {
    while ($c =~ /\b(?:event_type|eventType)\s*(?:=|==|===|!=|!==|:)\s*$q([a-z][a-z0-9_]*)$q/g) { emit($f, $1); }
    while ($c =~ /\bevent_type\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/gi) { emit($f, lits($1)); }
    while ($c =~ /\binsertAudit\(\s*(?:\w+\s*,\s*)?\{[^;]{0,600}?\bevent_type\s*:\s*(\w+)\s*[,}\n]/g) {
      my $value = const_value($f, $1);
      emit($f, $value) if defined $value;
    }
    while ($c =~ /\b(?:auditCheatcode|auditMilestone)\(\s*(?:db\s*,\s*)?'([a-z][a-z0-9_]*)'/g) { emit($f, $1); }
    while ($c =~ /\btmb_audit_append$sep$tok$sep$tok$sep$tok$sep$tok$sep(["']?)([a-z][a-z0-9_]*)\1$end/g) { emit($f, $2); }
    while ($c =~ /\b(?:tmb_audit_sql|_tmb_fallback_audit_sql|tmb_fallback_audit_append)$sep$tok$sep$tok$sep$tok$sep(["']?)([a-z][a-z0-9_]*)\1$end/g) { emit($f, $2); }
    while ($c =~ /\bINSERT INTO audit\s*\(/g) {
      my $tail = substr($c, pos($c), 600);
      emit($f, $1) if $tail =~ /'(?:system|hook:[a-z0-9-]+)',\s*'([a-z][a-z0-9_]*)'/;
    }
  } elsif ($enum eq 'audit.from_node') {
    while ($c =~ /\bfrom_node\s*(?:=|==|===|:)\s*$q([a-z][a-z0-9:-]*)$q/g) { emit($f, $1); }
    while ($c =~ /\bINSERT INTO audit\s*\(/g) {
      my $tail = substr($c, pos($c), 600);
      emit($f, $1) if $tail =~ /'(system|hook:[a-z0-9-]+)',\s*'[a-z]/;
    }
    (my $complete = $c) =~ s/\.startsWith\(\s*$q[^"'\n]*$q|${q}hook:$q\s*\+//g;
    while ($complete =~ /$q(hook:[^"' \n]*)$q/g) { emit($f, $1); }
  } elsif ($enum eq 'tasks.status') {
    while ($c =~ /\bUPDATE tasks\s+SET\s+status\s*=\s*'([a-z_]+)'/g) { emit($f, $1); }
    while ($c =~ /\b(?:t|tasks|task)\.status\s*(?:=|==|===|!=|!==|<>)\s*$q([a-z_]+)$q/g) { emit($f, $1); }
    while ($c =~ /\b(?:t|tasks)\.status\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/gi) { emit($f, lits($1)); }
  } elsif ($enum eq 'issues.status') {
    while ($c =~ /\bUPDATE issues\s+SET\s+status\s*=\s*'([a-z_]+)'/g) { emit($f, $1); }
    while ($c =~ /\b(?:i|issues|issue)\.status\s*(?:=|==|===|!=|!==|<>)\s*$q([a-z_]+)$q/g) { emit($f, $1); }
    while ($c =~ /\b(?:i|issues)\.status\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/gi) { emit($f, lits($1)); }
  } elsif ($enum eq 'validation_attempts.verdict') {
    while ($c =~ /\bverdict\s*(?:=|==|===|!=|!==|:)\s*$q([a-z_]+)$q/g) { emit($f, $1); }
    while ($c =~ /\bverdict\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/gi) { emit($f, lits($1)); }
  } elsif ($enum eq 'discussions.kind') {
    while ($c =~ /\binsertDiscussion\(\s*db\s*,\s*\{[^;]{0,400}?\bkind:\s*'([a-z_]+)'/g) { emit($f, $1); }
    for my $line (split /\n/, $c) {
      next unless $line =~ /\bdiscussions\b/;
      while ($line =~ /\bkind\s*(?:=|==|===)\s*'([a-z_]+)'/g) { emit($f, $1); }
      while ($line =~ /\bkind\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/gi) { emit($f, lits($1)); }
    }
  } elsif ($enum eq 'milestones.state') {
    while ($c =~ /\bUPDATE milestones\s+SET\s+state\s*=\s*'([a-z_]+)'/g) { emit($f, $1); }
    while ($c =~ /\bm\.state\s*(?:=|==|===|!=|!==)\s*$q([a-z_]+)$q/g) { emit($f, $1); }
    if ($f =~ /milestones\.[a-z]+$/) {
      while ($c =~ /\bstate\s*(?:=|==|===|!=|!==|:)\s*$q([a-z_]+)$q/g) { emit($f, $1); }
    }
  } elsif ($enum eq 'agent_runs.usage_source') {
    while ($c =~ /\busage_source\s*(?:=|==|===|!=|!==|:)\s*$q([a-z_]+)$q/g) { emit($f, $1); }
    while ($c =~ /\busage_source\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/gi) { emit($f, lits($1)); }
  } else {
    die "enums-stable-extract: unknown enum $enum\n";
  }
}

my %seen;
print "$_\n" for grep { !$seen{$_}++ } @out;
