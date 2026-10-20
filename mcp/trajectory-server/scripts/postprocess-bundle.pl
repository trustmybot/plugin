#!/usr/bin/env perl

use strict;
use warnings;

@ARGV or die "usage: postprocess-bundle.pl <bundle> [<bundle> ...]\n";

for my $path (@ARGV) {
  open my $input, '<:raw', $path or die "cannot read $path: $!\n";
  local $/;
  my $contents = <$input>;
  close $input or die "cannot close $path after reading: $!\n";

  # esbuild labels modules by their path in Bun's package store. The number of
  # parent-directory segments varies between a root checkout and a worktree,
  # but the label is cosmetic. Do not normalize any other bytes: dependency
  # source can contain significant whitespace inside JavaScript strings.
  $contents =~ s{(?:\.\./)+node_modules/\.bun/}{node_modules/.bun/}g;

  open my $output, '>:raw', $path or die "cannot write $path: $!\n";
  print {$output} $contents or die "cannot write $path: $!\n";
  close $output or die "cannot close $path after writing: $!\n";
}
