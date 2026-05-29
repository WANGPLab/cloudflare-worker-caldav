#!/usr/bin/env python3
"""CalDAV Worker 账号管理脚本

密码参数均可省略，省略时会隐藏式交互输入，避免 shell 历史泄露和特殊字符问题。
"""
import requests
import sys
import argparse
from getpass import getpass

BASE_URL = "https://my-first-worker.tlianyun.workers.dev"


def register(username, password, admin_password):
    r = requests.post(f"{BASE_URL}/api/register", json={
        "username": username,
        "password": password,
        "adminPassword": admin_password,
    })
    data = r.json()
    if r.status_code == 201:
        print(f"注册成功: {data['username']}")
        print(f"  Thunderbird URL: {BASE_URL}/{data['username']}/default/")
    else:
        print(f"注册失败: {data.get('error', '未知错误')}")
        sys.exit(1)


def change_password(username, old_password, new_password):
    r = requests.post(f"{BASE_URL}/api/change-password",
        auth=(username, old_password),
        json={"oldPassword": old_password, "newPassword": new_password},
    )
    data = r.json()
    if r.status_code == 200:
        print(f"密码修改成功: {username}")
    else:
        print(f"修改失败: {data.get('error', '未知错误')}")
        sys.exit(1)


def delete_user(username, admin_password):
    r = requests.post(f"{BASE_URL}/api/delete-user", json={
        "username": username,
        "adminPassword": admin_password,
    })
    data = r.json()
    if r.status_code == 200:
        print(f"已删除用户: {data['username']}")
    else:
        print(f"删除失败: {data.get('error', '未知错误')}")
        sys.exit(1)


def change_username(old_username, new_username, password):
    r = requests.post(f"{BASE_URL}/api/change-username",
        auth=(old_username, password),
        json={"newUsername": new_username, "password": password},
    )
    data = r.json()
    if r.status_code == 200:
        print("用户名修改完成")
        print(f"  {old_username} -> {data.get('username', new_username)}")
        print(f"  Thunderbird URL: {BASE_URL}/{data.get('username', new_username)}/default/")
    else:
        print(f"修改失败: {data.get('error', '未知错误')}")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="CalDAV Worker 账号管理")
    sub = parser.add_subparsers(dest="cmd", required=True)

    reg = sub.add_parser("register", help="注册新用户")
    reg.add_argument("username")
    reg.add_argument("-p", "--password", nargs="?", default=None, help="新用户密码（省略则交互输入）")
    reg.add_argument("-a", "--admin-password", nargs="?", default=None, help="admin 密码（省略则交互输入）")

    pwd = sub.add_parser("change-password", help="修改密码")
    pwd.add_argument("username")
    pwd.add_argument("-o", "--old-password", nargs="?", default=None, help="旧密码（省略则交互输入）")
    pwd.add_argument("-n", "--new-password", nargs="?", default=None, help="新密码（省略则交互输入）")

    user = sub.add_parser("change-username", help="修改用户名")
    user.add_argument("old_username")
    user.add_argument("new_username")
    user.add_argument("-p", "--password", nargs="?", default=None, help="密码（省略则交互输入）")

    del_cmd = sub.add_parser("delete-user", help="删除用户")
    del_cmd.add_argument("username")
    del_cmd.add_argument("-a", "--admin-password", nargs="?", default=None, help="admin 密码（省略则交互输入）")

    args = parser.parse_args()

    if args.cmd == "register":
        password = args.password or getpass("新用户密码: ")
        admin_pw = args.admin_password or getpass("admin 密码: ")
        register(args.username, password, admin_pw)

    elif args.cmd == "change-password":
        old = args.old_password or getpass("旧密码: ")
        new = args.new_password or getpass("新密码: ")
        change_password(args.username, old, new)

    elif args.cmd == "change-username":
        pw = args.password or getpass("密码: ")
        change_username(args.old_username, args.new_username, pw)

    elif args.cmd == "delete-user":
        admin_pw = args.admin_password or getpass("admin 密码: ")
        delete_user(args.username, admin_pw)


if __name__ == "__main__":
    main()
