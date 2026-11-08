module example.com/svc

go 1.24

require github.com/stretchr/testify v1.9.0

tool github.com/golangci/golangci-lint/v2/cmd/golangci-lint

tool (
	golang.org/x/tools/cmd/goimports
	gotest.tools/gotestsum
)
