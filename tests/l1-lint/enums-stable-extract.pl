#!/usr/bin/env perl
# Helper for enums-stable.sh.
# Usage: enums-stable-extract.pl <enum> <schema.sql> <file>...
# Prints "<value>\t<file>" for every literal of <enum> the schema CHECK lists
# and the code files hold, first occurrence per (value, file).
use strict;
use warnings;

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

  if ($enum eq 'audit.event_type') {
    while ($c =~ /\bevent_type\s*(?:=|==|===|!=|!==|:)\s*$q([a-z][a-z0-9_]*)$q/g) { emit($f, $1); }
    while ($c =~ /\bevent_type\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/gi) { emit($f, lits($1)); }
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
    while ($c =~ /$q(hook:[^"' \n]*)$q/g) { emit($f, $1); }
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
