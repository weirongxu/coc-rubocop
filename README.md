# Rubocop for coc.nvim

This extension provides interfaces to rubocop for coc.nvim.

Port from [ruby-rubocop](https://github.com/misogi/vscode-ruby-rubocop)

[rubocop](https://github.com/bbatsov/rubocop) is a code analyzer for ruby.

## Problems

This extension may have problems when using a rvm or chruby environment.
When autoCorrect is enabled, the history of changing file is broken.

## Features

- lint by executing the command "Ruby: lint by rubocop"
- auto invoke when saving file
- auto correct command "Ruby: autocorrect by rubocop"

### Exclude file

The extension forces rubocop's `force-exclusion` option.

If you do not want rubocop to be executed on some file, you can add AllCops/Exclude in rubocop.yml. The file can be saved without executing rubocop.

# Installation

Installation of ruby and rubocop is required.

```
gem install rubocop
```

Installation by vim-plug and yarn

```vim
Plug 'weirongxu/coc-rubocop', {'do': 'yarn install --frozen-lockfile'}
```

<!-- `:CocInstall coc-rubocop` -->

## Configuration

Specify configuration `coc-settings.json`:

```javascript
{
  // If not specified searches for 'rubocop' executable available on PATH (default and recommended)
  "ruby.rubocop.executePath": "",

  // You can use specific path
  // "ruby.rubocop.executePath": "/Users/you/.rbenv/shims/"
  // "ruby.rubocop.executePath": "/Users/you/.rvm/gems/ruby-2.3.2/bin/"
  // "ruby.rubocop.executePath": "D:/bin/Ruby22-x64/bin/"

  // If not specified, it assumes a null value by default.
  "ruby.rubocop.configFilePath": "/path/to/config/.rubocop.yml",

  // default true
  "ruby.rubocop.onSave": true
}
```

### Commands

- `ruby.rubocop`: Lint by rubocop

# Contribute with this extension

Please install packages with yarn.

    yarn install

You could install ESLint extension for .ts files.

Please format code using prettier.

```
yarn prettier src/* test/* --write
```

# License

This software is released under the MIT License, see [LICENSE](LICENSE).
