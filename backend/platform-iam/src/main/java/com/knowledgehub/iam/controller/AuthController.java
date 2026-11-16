package com.knowledgehub.iam.controller;

import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.common.security.CurrentUser;
import com.knowledgehub.common.security.UserContext;
import com.knowledgehub.iam.service.AuthService;
import com.knowledgehub.iam.service.RetrievalTicketService;
import com.knowledgehub.iam.service.UserService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AuthService authService;
    private final UserService userService;
    private final RetrievalTicketService ticketService;

    public AuthController(AuthService authService, UserService userService, RetrievalTicketService ticketService) {
        this.authService = authService;
        this.userService = userService;
        this.ticketService = ticketService;
    }

    @PostMapping("/login")
    public ApiResponse<AuthService.LoginResult> login(@Valid @RequestBody LoginRequest request) {
        return ApiResponse.ok(authService.login(request.tenantId(), request.username(), request.password()));
    }

    /** 自助注册：成功后直接返回登录态，前端无需再调一次 login。 */
    @PostMapping("/register")
    public ApiResponse<AuthService.LoginResult> register(@Valid @RequestBody RegisterRequest request) {
        return ApiResponse.ok(authService.register(request.tenantId(), request.username(),
                request.password(), request.displayName()));
    }

    @PostMapping("/refresh")
    public ApiResponse<AuthService.LoginResult> refresh(@Valid @RequestBody RefreshRequest request) {
        return ApiResponse.ok(authService.refresh(request.refreshToken()));
    }

    @GetMapping("/me")
    public ApiResponse<Map<String, Object>> me() {
        return ApiResponse.ok(authService.toProfile(UserContext.require()));
    }

    @PostMapping("/password")
    public ApiResponse<Void> changePassword(@Valid @RequestBody ChangePasswordRequest request) {
        userService.changePassword(UserContext.require().userId(), request.oldPassword(), request.newPassword());
        return ApiResponse.ok();
    }

    @PostMapping("/ticket")
    public ApiResponse<TicketResponse> ticket(@RequestBody TicketRequest request) {
        CurrentUser user = UserContext.require();
        List<UUID> kbIds = request.kbIds() == null ? List.of()
                : request.kbIds().stream().map(UUID::fromString).toList();
        return ApiResponse.ok(new TicketResponse(ticketService.issue(user, kbIds)));
    }

    public record LoginRequest(String tenantId, @NotBlank String username, @NotBlank String password) {
    }

    public record RegisterRequest(String tenantId, @NotBlank String username, @NotBlank String password,
                                  String displayName) {
    }

    public record RefreshRequest(@NotBlank String refreshToken) {
    }

    public record ChangePasswordRequest(@NotBlank String oldPassword, @NotBlank String newPassword) {
    }

    public record TicketRequest(List<String> kbIds) {
    }

    public record TicketResponse(String ticket) {
    }
}