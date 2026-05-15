package main

import "net/http"

type ResourceServer struct{}

func StartServer() {
	http.HandleFunc("/resources", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}
